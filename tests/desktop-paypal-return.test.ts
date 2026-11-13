// Exercises checkout return correlation and payment ordering with synthetic dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { fixture } from './support/paypal-session-fixture';

async function setup(
  openExternal: (url: string) => Promise<void> = async () => {},
) {
  const f = fixture();
  const states: string[] = [];
  let orders = 0;
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
      orders += 1;
      f.calls.push('create');
      return {
        orderId: `ORDER${orders}`,
        approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER${orders}`,
      };
    },
  };
  const service = createDesktopPaypalSession(
    await createPaypalSession({ ...f, payment }),
    openExternal,
  );
  return { f, states, service };
}

void test('only a matching single-use return can start its approved order', async () => {
  const { f, states, service } = await setup();
  await service.create();
  const state = states[0];
  assert.ok(state);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  await service.openApproval();
  assert.equal(
    service.noteApprovedReturn({ state: 'b'.repeat(43), token: 'ORDER1' }),
    false,
  );
  assert.equal(service.noteApprovedReturn({ state, token: 'OTHER' }), false);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  assert.equal((await service.consumeApprovedReturn()).phase, 'active');
  await service.consumeApprovedReturn();
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a return from an abandoned order cannot authorize its replacement', async () => {
  const { f, states, service } = await setup();
  await service.create();
  await service.openApproval();
  const oldState = states[0];
  assert.ok(oldState);
  assert.equal(
    service.noteApprovedReturn({ state: oldState, token: 'ORDER1' }),
    true,
  );
  await service.abandon();
  await service.create();
  await service.openApproval();
  const newState = states[1];
  assert.ok(newState);
  assert.notEqual(newState, oldState);
  assert.equal(
    service.noteApprovedReturn({ state: oldState, token: 'ORDER1' }),
    false,
  );
  await service.consumeApprovedReturn();
  assert.deepEqual(f.calls, ['create', 'create']);
  assert.equal(service.noteApprovedReturn({ state: newState }), true);
  await service.consumeApprovedReturn();
  assert.deepEqual(f.calls, ['create', 'create', 'authorize']);
});

void test('a return arriving while the browser is opening is retained', async () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { f, states, service } = await setup(async () => wait);
  await service.create();
  const opening = service.openApproval();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  assert.ok(release);
  release();
  await opening;
  assert.equal((await service.consumeApprovedReturn()).phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a rejected second create keeps the original checkout armed', async () => {
  const { f, states, service } = await setup();
  await service.create();
  await service.openApproval();
  await assert.rejects(service.create());
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  assert.equal((await service.consumeApprovedReturn()).phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a correlated cancellation disarms later approval without changing the order', async () => {
  const { f, states, service } = await setup();
  await service.create();
  await service.openApproval();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteCancelledReturn({ state, token: 'OTHER' }), false);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), false);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  assert.equal((await service.consumeApprovedReturn()).phase, 'created');
  assert.equal(await service.consumeCancelledReturn(), true);
  assert.equal(await service.consumeCancelledReturn(), false);
  assert.deepEqual(f.calls, ['create']);
});

void test('cancellation before a queued approved return is consumed prevents authorization', async () => {
  const { f, states, service } = await setup();
  await service.create();
  await service.openApproval();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
  assert.equal((await service.consumeApprovedReturn()).phase, 'created');
  assert.equal(await service.consumeCancelledReturn(), true);
  assert.deepEqual(f.calls, ['create']);
});

void test('cancellation during the approval check prevents authorization whether PayPal says approved or pending', async () => {
  for (const approved of [true, false]) {
    const { f, states, service } = await setup();
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.payment.isApproved = async () => {
      await wait;
      return approved;
    };
    await service.create();
    await service.openApproval();
    const checking = service.approve();
    const state = states[0];
    assert.ok(state);
    assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
    assert.ok(release);
    release();
    await assert.rejects(checking, (error: unknown) => {
      assert.ok(error instanceof PaypalError);
      assert.equal(error.code, PAYPAL_ERROR_CODES.INTERRUPTED);
      return true;
    });
    assert.equal(service.status().phase, 'created');
    assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
    assert.equal(await service.consumeCancelledReturn(), true);
    assert.deepEqual(f.calls, ['create']);
  }
});

void test('a cancellation cannot misreport an authorization that has already started', async () => {
  const { f, states, service } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.payment.authorize = async () => {
    f.calls.push('authorize');
    await wait;
    return { authorizationId: 'AUTH1' };
  };
  await service.create();
  await service.openApproval();
  const checking = service.approve();
  await new Promise((resolve) => setImmediate(resolve));
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), false);
  assert.ok(release);
  release();
  assert.equal((await checking).phase, 'active');
  assert.equal(await service.consumeCancelledReturn(), false);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('cancellation during the authorization journal write stops the payment before dispatch', async () => {
  const { f, states, service } = await setup();
  const write = f.journal.write;
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.journal.write = async (value) => {
    if (
      value &&
      typeof value === 'object' &&
      'phase' in value &&
      value.phase === 'authorizing'
    ) {
      reached?.();
      await wait;
    }
    await write(value);
  };
  await service.create();
  await service.openApproval();
  const checking = service.approve();
  await writing;
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteCancelledReturn({ state, token: 'ORDER1' }), true);
  assert.ok(release);
  release();
  await assert.rejects(checking);
  assert.equal((await createPaypalSession(f)).status().phase, 'created');
  assert.deepEqual(f.calls, ['create']);
});

void test('closing during the approval check prevents a new authorization', async () => {
  const { f, service } = await setup();
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkingStarted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.payment.isApproved = async () => {
    reached?.();
    await wait;
    return true;
  };
  await service.create();
  await service.openApproval();
  const checking = service.approve();
  await checkingStarted;
  const closing = service.close();
  assert.ok(release);
  release();
  await assert.rejects(checking);
  await closing;
  assert.deepEqual(f.calls, ['create']);
});

void test('a failed approval is not retried by duplicate returns', async () => {
  const { f, states, service } = await setup();
  f.payment.isApproved = async () => false;
  await service.create();
  await service.openApproval();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await assert.rejects(service.consumeApprovedReturn());
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  assert.equal(service.status().phase, 'created');
  assert.equal(service.status().approvalLinkAvailable, false);
  assert.deepEqual(f.calls, ['create']);
});

void test('a journal failure before authorization prevents the payment call', async () => {
  const { f, states, service } = await setup();
  const write = f.journal.write;
  f.journal.write = async (value) => {
    if (
      value &&
      typeof value === 'object' &&
      'phase' in value &&
      value.phase === 'authorizing'
    )
      throw new Error('synthetic journal failure');
    await write(value);
  };
  await service.create();
  await service.openApproval();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await assert.rejects(service.consumeApprovedReturn());
  assert.equal(service.status().phase, 'blocked');
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  assert.deepEqual(f.calls, ['create']);
});

void test('an ambiguous manual check disarms later automatic returns', async () => {
  const { f, states, service } = await setup();
  f.payment.isApproved = async () => {
    throw new Error('synthetic timeout');
  };
  await service.create();
  await service.openApproval();
  await assert.rejects(service.approve());
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  await service.consumeApprovedReturn();
  assert.deepEqual(f.calls, ['create']);
});

void test('an ambiguous manual check invalidates a return received while checking', async () => {
  const { f, states, service } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.payment.isApproved = async () => {
    await wait;
    throw new Error('synthetic timeout');
  };
  await service.create();
  await service.openApproval();
  const checking = service.approve();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  assert.ok(release);
  release();
  await assert.rejects(checking);
  await service.consumeApprovedReturn();
  assert.deepEqual(f.calls, ['create']);
});

void test('closing the service disarms any later return', async () => {
  const { f, states, service } = await setup();
  await service.create();
  await service.openApproval();
  const state = states[0];
  assert.ok(state);
  await service.close();
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  await assert.rejects(service.consumeApprovedReturn());
  assert.deepEqual(f.calls, ['create']);
});

void test('an uncertain authorization is never retried on return or restart', async () => {
  const { f, states, service } = await setup();
  f.payment.authorize = async () => {
    f.calls.push('authorize');
    throw new Error('synthetic timeout');
  };
  await service.create();
  await service.openApproval();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await assert.rejects(service.consumeApprovedReturn());
  assert.equal(service.status().phase, 'authorizing');
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), false);
  await assert.rejects(service.approve());
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.approve('ORDER1'));
  assert.deepEqual(f.calls, ['create', 'authorize']);
});
