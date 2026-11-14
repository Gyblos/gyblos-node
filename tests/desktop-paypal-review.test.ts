import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { paypalReviewDialog } from '@gyblos/desktop/paypal-model';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('the native review dialog defaults to holding the session and states the exact sandbox action', () => {
  const dialog = paypalReviewDialog({
    fingerprint: 'a'.repeat(64),
    spentCents: 20,
  });
  assert.equal(dialog.defaultId, 0);
  assert.equal(dialog.cancelId, 0);
  assert.deepEqual(dialog.buttons, [
    'Keep under review',
    'Waive and capture USD 0.20',
  ]);
  assert.match(dialog.message ?? '', /Sandbox/);
  assert.match(dialog.detail ?? '', /unknown outcome/);
  assert.match(dialog.detail ?? '', /no other PayPal operation is in progress/);
  assert.match(dialog.detail ?? '', /buyer and seller/);
  assert.doesNotMatch(dialog.detail ?? '', /a{64}/);
});

void test('manual review requires a native confirmation and settles only the exact reviewed amount', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-paypal-review-'));
  try {
    const journal = await openPaypalJournal(root);
    const f = fixture();
    const session = await createPaypalSession({
      ...f,
      journal,
      payment: {
        ...f.payment,
        async beginReview(_orderId, _requestId, authorizationId) {
          return {
            capture: (cents) => f.payment.capture(authorizationId, cents),
            release() {},
          };
        },
      },
      agentEngine: {
        model: 'synthetic-model',
        async generate() {
          throw new Error('synthetic uncertain inference');
        },
      },
    });
    const order = await session.create();
    await session.approve(order.orderId);
    for (const id of ['MESSAGE1', 'MESSAGE2']) {
      await session.message(order.orderId, 'synthetic', 16, id);
      await session.acknowledge(order.orderId, id);
    }
    await assert.rejects(
      session.agentMessage(
        order.orderId,
        {
          model: 'synthetic-model',
          messages: [{ role: 'user', content: 'synthetic' }],
          max_tokens: 16,
        },
        'AGENT1',
      ),
    );
    const service = createDesktopPaypalSession(session, async () => {});
    const contents = {};
    const frame = {};
    let approved = false;
    let confirmations = 0;
    const handlers = createDesktopPaypalHandlers(
      async () => ({ service, model: 'synthetic-model' }),
      { contents, mainFrame: () => frame, destroyed: () => false },
      async (ticket) => {
        confirmations += 1;
        assert.equal(ticket.spentCents, 20);
        assert.match(ticket.fingerprint, /^[a-f0-9]{64}$/);
        return approved;
      },
    );
    const event = { sender: contents, senderFrame: frame };
    assert.equal(
      (
        await handlers.run({ ...event, sender: {} }, [
          { action: 'review-and-settle' },
        ])
      ).error,
      'denied',
    );
    assert.equal(confirmations, 0);
    const declined = await handlers.run(event, [
      { action: 'review-and-settle' },
    ]);
    assert.equal(declined.status?.phase, 'executing');
    assert.equal(f.calls.includes('capture:20'), false);
    approved = true;
    const completed = await handlers.run(event, [
      { action: 'review-and-settle' },
    ]);
    assert.equal(completed.status?.phase, 'completed');
    assert.equal(completed.status?.spentCents, 20);
    assert.equal(f.calls.filter((call) => call === 'capture:20').length, 1);
    assert.equal(confirmations, 2);
    assert.doesNotMatch(JSON.stringify(completed), /ORDER1|AUTH1|AGENT1/);
    await service.close();
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('closing the desktop during review confirmation cannot start a capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-paypal-review-close-'));
  try {
    const journal = await openPaypalJournal(root);
    const f = fixture();
    const payment = {
      ...f.payment,
      async beginReview(
        _orderId: string,
        _requestId: string,
        authorizationId: string,
      ) {
        return {
          capture: (cents: number) => f.payment.capture(authorizationId, cents),
          release() {},
        };
      },
    };
    const session = await createPaypalSession({
      ...f,
      journal,
      payment,
      agentEngine: {
        model: 'synthetic-model',
        async generate() {
          throw new Error('synthetic uncertain inference');
        },
      },
    });
    const order = await session.create();
    await session.approve(order.orderId);
    await session.message(order.orderId, 'synthetic', 16, 'MESSAGE1');
    await session.acknowledge(order.orderId, 'MESSAGE1');
    await assert.rejects(
      session.agentMessage(
        order.orderId,
        {
          model: 'synthetic-model',
          messages: [{ role: 'user', content: 'synthetic' }],
          max_tokens: 16,
        },
        'AGENT1',
      ),
    );
    const service = createDesktopPaypalSession(session, async () => {});
    let entered: () => void = () => {};
    let allow: (value: boolean) => void = () => {};
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const confirmation = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const pending = service.reviewAndSettle(async () => {
      entered();
      return confirmation;
    });
    await reached;
    const closing = service.close();
    allow(true);
    await pending;
    await closing;
    assert.equal(session.status().phase, 'executing');
    assert.equal(
      f.calls.some((call) => call.startsWith('capture:')),
      false,
    );
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
