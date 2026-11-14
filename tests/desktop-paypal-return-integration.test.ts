// Integrates the loopback return, host session and renderer coordinator with synthetic services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDesktopPaypalCallback } from '@gyblos/desktop/paypal-callback';
import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { validatePaypalPrompt } from '@gyblos/node/paypal-startup';
import { createPaypalSandbox } from '@gyblos/payments-paypal';

import { fixture } from './support/paypal-session-fixture';

void test('a correlated browser return verifies and starts one session', async () => {
  const f = fixture();
  let state = '';
  const payment = {
    ...f.payment,
    async create(_requestId: string, returnState?: string) {
      state = returnState ?? '';
      return f.payment.create();
    },
  };
  const service = createDesktopPaypalSession(
    await createPaypalSession({ ...f, payment }),
    async () => {},
  );
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'synthetic-model' }),
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const chat = new PaypalChatController((request) =>
    handlers.run({ sender: contents, senderFrame: frame }, [request]),
  );
  let completion: Promise<void> = Promise.resolve();
  const callback = await openDesktopPaypalCallback((value) => {
    if (service.noteApprovedReturn(value))
      completion = chat.returnedFromPaypal();
  });
  try {
    await chat.refresh();
    await chat.startCheckout();
    assert.equal(chat.getSnapshot().status?.phase, 'created');
    await fetch(
      `${callback.origin}/paypal/approved?state=${state}&token=OTHER`,
    );
    assert.deepEqual(f.calls, ['create']);
    await fetch(
      `${callback.origin}/paypal/approved?state=${state}&token=ORDER1`,
    );
    await completion;
    assert.equal(chat.getSnapshot().status?.phase, 'active');
    await fetch(
      `${callback.origin}/paypal/approved?state=${state}&token=ORDER1`,
    );
    await completion;
    assert.deepEqual(f.calls, ['create', 'authorize']);
  } finally {
    await callback.close();
    await service.close();
  }
});

void test('the provider return URL drives one checked authorization end to end', async () => {
  const f = fixture();
  let returnUrl = '';
  let requestId = '';
  let authorizations = 0;
  let completion: Promise<void> = Promise.resolve();
  let notify: (value: { state: string; token?: string }) => void = () => {};
  const callback = await openDesktopPaypalCallback((value) => notify(value));
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: callback.origin,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders')) {
        requestId = new Headers(init?.headers).get('paypal-request-id') ?? '';
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(
          body && typeof body === 'object' && 'application_context' in body,
        );
        const context = body.application_context;
        assert.ok(
          context && typeof context === 'object' && 'return_url' in context,
        );
        assert.ok(typeof context.return_url === 'string');
        returnUrl = context.return_url;
        return Response.json({
          id: 'ORDER1',
          status: 'CREATED',
          links: [
            {
              rel: 'approve',
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
            },
          ],
        });
      }
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json({
          id: 'ORDER1',
          status: 'APPROVED',
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              custom_id: requestId,
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        });
      if (url.endsWith('/v2/checkout/orders/ORDER1/authorize')) {
        authorizations += 1;
        return Response.json({
          id: 'ORDER1',
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                authorizations: [
                  {
                    id: 'AUTH1',
                    status: 'CREATED',
                    amount: { currency_code: 'USD', value: '1.00' },
                  },
                ],
              },
            },
          ],
        });
      }
      throw new Error('Unexpected synthetic request');
    },
  });
  const service = createDesktopPaypalSession(
    await createPaypalSession({ ...f, payment }),
    async () => {},
  );
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'synthetic-model' }),
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const chat = new PaypalChatController((request) =>
    handlers.run({ sender: contents, senderFrame: frame }, [request]),
  );
  notify = (value) => {
    if (service.noteApprovedReturn(value))
      completion = chat.returnedFromPaypal();
  };
  try {
    await chat.refresh();
    await chat.startCheckout();
    assert.ok(returnUrl.startsWith(callback.origin));
    const returned = new URL(returnUrl);
    returned.searchParams.set('token', 'ORDER1');
    await fetch(returned);
    await completion;
    assert.equal(chat.getSnapshot().status?.phase, 'active');
    await fetch(returned);
    await completion;
    assert.equal(authorizations, 1);
  } finally {
    await callback.close();
    await service.close();
  }
});

void test('cancelling while PayPal authentication is pending sends no authorization', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const authenticating = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let tokens = 0;
  let authorizations = 0;
  let requestId = '';
  let state = '';
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) {
        tokens += 1;
        if (tokens === 2) {
          reached?.();
          await wait;
        }
        return Response.json({ access_token: 'synthetic-token' });
      }
      if (url.endsWith('/v2/checkout/orders')) {
        requestId = new Headers(init?.headers).get('paypal-request-id') ?? '';
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(
          body && typeof body === 'object' && 'application_context' in body,
        );
        const context = body.application_context;
        assert.ok(
          context &&
            typeof context === 'object' &&
            'return_url' in context &&
            typeof context.return_url === 'string',
        );
        state = new URL(context.return_url).searchParams.get('state') ?? '';
        return Response.json({
          id: 'ORDER1',
          status: 'CREATED',
          links: [
            {
              rel: 'approve',
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
            },
          ],
        });
      }
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json({
          id: 'ORDER1',
          status: 'APPROVED',
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              custom_id: requestId,
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        });
      authorizations += 1;
      throw new Error('unexpected authorization');
    },
  });
  const service = createDesktopPaypalSession(
    await createPaypalSession({ ...f, payment }),
    async () => {},
  );
  await service.create();
  await service.openApproval();
  const checking = service.approve();
  await authenticating;
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
  assert.ok(release);
  release();
  await assert.rejects(checking);
  assert.equal(await service.consumeCancelledReturn(), true);
  assert.equal(authorizations, 0);
  assert.equal(tokens, 2);
});

async function setup() {
  const f = fixture();
  const opened: string[] = [];
  const states: string[] = [];
  const payment = {
    ...f.payment,
    async isApproved() {
      return f.payment.isApproved();
    },
    async authorize() {
      return f.payment.authorize();
    },
    async create(_requestId: string, state?: string) {
      assert.ok(state);
      states.push(state);
      return f.payment.create();
    },
  };
  const service = createDesktopPaypalSession(
    await createPaypalSession({
      ...f,
      payment,
      validateRequest: validatePaypalPrompt,
    }),
    async (url) => {
      opened.push(url);
    },
  );
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'qwen-test' }),
    {
      contents,
      mainFrame: () => frame,
      destroyed: () => false,
    },
  );
  const event = { sender: contents, senderFrame: frame };
  const run = (request: unknown) => handlers.run(event, [request]);
  return {
    f,
    opened,
    run,
    service,
    states,
    chat: new PaypalChatController(run),
  };
}

void test('cancellation during browser opening is shown after the opening completes', async () => {
  const { f, run, service, states } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = new PaypalChatController(async (request) => {
    const result = await run(request);
    if (request.action === 'open') await wait;
    return result;
  });
  await chat.refresh();
  await chat.create();
  const opening = chat.openApproval();
  await new Promise((resolve) => setImmediate(resolve));
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
  await chat.cancelledFromPaypal();
  assert.ok(release);
  release();
  await opening;
  assert.match(chat.getSnapshot().notice, /cancel/i);
  assert.equal(chat.getSnapshot().status?.approvalLinkAvailable, false);
  assert.equal(chat.getSnapshot().status?.phase, 'created');
  await chat.refresh();
  assert.match(chat.getSnapshot().notice, /cancel/i);
  assert.deepEqual(f.calls, ['create']);
});

void test('a late cancellation notice from an old order does not describe a replacement order', async () => {
  const { f, chat, service, states } = await setup();
  await chat.refresh();
  await chat.startCheckout();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
  await chat.abandon();
  await chat.startCheckout();
  await chat.cancelledFromPaypal();
  assert.doesNotMatch(chat.getSnapshot().notice, /cancel/i);
  assert.equal(chat.getSnapshot().status?.phase, 'created');
  assert.equal(chat.getSnapshot().status?.approvalLinkAvailable, true);
  assert.deepEqual(f.calls, ['create', 'create']);
});
