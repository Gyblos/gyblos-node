import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalAgentAccess } from '@gyblos/desktop/paypal-agent-access';

void test('agent access starts once only after a sandbox session is active', async () => {
  let phase = 'ready';
  let opened = 0;
  let closed = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => true,
    isBusy: () => false,
    hasPending: () => false,
    async acknowledgePending() {},
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase,
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async () => {
      opened += 1;
      return endpoint;
    },
  );
  await assert.rejects(access.connect());
  assert.equal(opened, 0);
  phase = 'active';
  const pending = [access.connect(), access.connect()];
  const [first, second] = await Promise.all(pending);
  assert.equal(opened, 1);
  assert.equal(first.url, endpoint.url);
  assert.equal(Object.hasOwn(second, 'key'), false);
  await access.close();
  assert.equal(closed, 1);
  await assert.rejects(access.connect());
});

void test('disconnect asks the endpoint to drain a running inference', async () => {
  let closed = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => true,
    isBusy: () => true,
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async () => endpoint,
  );
  await access.connect();
  await access.disconnect();
  assert.equal(closed, 1);
});

void test('application shutdown waits for an in-flight disconnect', async () => {
  let closed = 0;
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => true,
    isBusy: () => false,
    hasPending: () => false,
    async acknowledgePending() {},
    async close() {
      closed += 1;
      entered();
      await waiting;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async () => endpoint,
  );
  await access.connect();
  const disconnect = access.disconnect();
  await started;
  const shutdown = access.close();
  await Promise.resolve();
  try {
    assert.equal(closed, 1);
  } finally {
    release();
  }
  await Promise.all([disconnect, shutdown]);
  assert.equal(closed, 1);
});

void test('a new session gets a new connection and the previous endpoint is closed', async () => {
  let generation = 1;
  let closed = 0;
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async () => {
      const openedGeneration = generation;
      return {
        url: 'http://127.0.0.1:12345/v1',
        key: `key-${generation}`,
        model: 'synthetic-model',
        budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
        isCurrent: () => openedGeneration === generation,
        isBusy: () => false,
        hasPending: () => false,
        async acknowledgePending() {},
        async close() {
          closed += 1;
        },
      };
    },
  );
  await access.connect();
  assert.ok(access.copyKey((key) => assert.equal(key, 'key-1')));
  generation = 2;
  assert.equal(access.status(), null);
  await access.connect();
  assert.ok(access.copyKey((key) => assert.equal(key, 'key-2')));
  assert.equal(closed, 1);
  await access.close();
});

void test('disconnect closes a busy endpoint', async () => {
  let closed = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => true,
    isBusy: () => true,
    hasPending: () => false,
    async acknowledgePending() {},
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async () => endpoint,
  );
  await access.connect();
  await access.disconnect();
  assert.equal(closed, 1);
  await access.close();
});

void test('the connection reports current shared usage and an uncertain session', async () => {
  let spentCents = 0;
  let phase = 'active';
  let expired = false;
  let remainingAttempts = 30;
  let busy = false;
  let sharedBusy = false;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => true,
    isBusy: () => busy,
    async close() {},
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase, expired, spentCents, limitCents: 100, remainingAttempts }),
    async () => endpoint,
    () => sharedBusy,
  );
  assert.equal((await access.connect()).spentCents, 0);
  spentCents = 20;
  assert.equal(access.status()?.spentCents, 20);
  assert.equal(access.status()?.limitCents, 100);
  phase = 'blocked';
  assert.equal(access.status()?.usageUncertain, true);
  for (const uncertain of [
    'executing',
    'message_pending',
    'capturing',
    'voiding',
  ]) {
    phase = uncertain;
    assert.equal(access.status()?.usageUncertain, true);
  }
  phase = 'active';
  expired = true;
  assert.equal(access.status()?.usageUncertain, true);
  expired = false;
  remainingAttempts = 0;
  assert.equal(access.status()?.usageUncertain, true);
  remainingAttempts = 30;
  busy = true;
  assert.equal(access.status()?.usageUncertain, true);
  busy = false;
  sharedBusy = true;
  assert.equal(access.status()?.usageState, 'busy');
  await access.close();
});

void test('a connection remains visibly disconnecting while an inference drains', async () => {
  let closing = false;
  let entered = () => {};
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => !closing,
    isBusy: () => true,
    async close() {
      closing = true;
      entered();
      await waiting;
    },
  };
  const activeAccess = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async () => endpoint,
  );
  await activeAccess.connect();
  const stopping = activeAccess.disconnect();
  try {
    await started;
    assert.equal(activeAccess.status()?.disconnecting, true);
    assert.equal(activeAccess.status()?.usageUncertain, true);
  } finally {
    release();
  }
  await stopping;
  assert.equal(activeAccess.status(), null);
});

void test('connection status explains expiration and attempt exhaustion', async () => {
  let expired = false;
  let remainingAttempts = 30;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => true,
    isBusy: () => false,
    async close() {},
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired,
      remainingAttempts,
      spentCents: 10,
      limitCents: 100,
    }),
    async () => endpoint,
  );
  await access.connect();
  expired = true;
  assert.equal(access.status()?.usageState, 'expired');
  expired = false;
  remainingAttempts = 0;
  assert.equal(access.status()?.usageState, 'attempts_exhausted');
  await access.close();
});

void test('a failed disconnect stays visible and can be retried', async () => {
  let calls = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic',
    model: 'synthetic-model',
    budget: () => ({ keyLimitCents: 100, keySpentCents: 0 }),
    isCurrent: () => false,
    isBusy: () => false,
    async close() {
      calls += 1;
      if (calls === 1) throw new Error('synthetic close failure');
    },
  };
  let current = true;
  endpoint.isCurrent = () => current;
  endpoint.close = async () => {
    calls += 1;
    current = false;
    if (calls === 1) throw new Error('synthetic close failure');
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      remainingAttempts: 30,
      spentCents: 0,
      limitCents: 100,
    }),
    async () => endpoint,
  );
  await access.connect();
  await assert.rejects(access.disconnect());
  assert.equal(access.status()?.usageState, 'disconnect_failed');
  await access.disconnect();
  assert.equal(access.status(), null);
  assert.equal(calls, 2);
});

void test('reconnecting an existing key never resets or raises its spend cap', async () => {
  let spent = 0;
  let starts = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic',
    isCurrent: () => true,
    isBusy: () => false,
    async close() {},
    budget: () => ({ keyLimitCents: 20, keySpentCents: spent }),
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: 'active',
      expired: false,
      spentCents: spent,
      limitCents: 100,
      remainingAttempts: 30,
    }),
    async (limit) => {
      starts += 1;
      assert.equal(limit, 20);
      return endpoint;
    },
  );
  try {
    await access.connect(20);
    spent = 20;
    const repeated = await access.connect(100);
    assert.equal(starts, 1);
    assert.equal(repeated.keyLimitCents, 20);
    assert.equal(repeated.keySpentCents, 20);
    assert.equal(repeated.usageState, 'key_limit_reached');
  } finally {
    await access.close();
  }
});
