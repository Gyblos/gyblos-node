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
    isCurrent: () => true,
    isBusy: () => false,
    hasPending: () => false,
    async acknowledgePending() {},
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase, expired: false, spentCents: 0, limitCents: 100 }),
    async () => {
      opened += 1;
      return endpoint;
    },
  );
  await assert.rejects(access.connect());
  assert.equal(opened, 0);
  phase = 'active';
  const [first, second] = await Promise.all([
    access.connect(),
    access.connect(),
  ]);
  assert.equal(opened, 1);
  assert.equal(first.url, endpoint.url);
  assert.equal(second.key, endpoint.key);
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
    isCurrent: () => true,
    isBusy: () => true,
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase: 'active', expired: false, spentCents: 0, limitCents: 100 }),
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
    () => ({ phase: 'active', expired: false, spentCents: 0, limitCents: 100 }),
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
    () => ({ phase: 'active', expired: false, spentCents: 0, limitCents: 100 }),
    async () => {
      const openedGeneration = generation;
      return {
        url: 'http://127.0.0.1:12345/v1',
        key: `key-${generation}`,
        model: 'synthetic-model',
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
  assert.equal((await access.connect()).key, 'key-1');
  generation = 2;
  assert.equal(access.status(), null);
  assert.equal((await access.connect()).key, 'key-2');
  assert.equal(closed, 1);
  await access.close();
});

void test('disconnect closes a busy endpoint', async () => {
  let closed = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic',
    model: 'synthetic-model',
    isCurrent: () => true,
    isBusy: () => true,
    hasPending: () => false,
    async acknowledgePending() {},
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase: 'active', expired: false, spentCents: 0, limitCents: 100 }),
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
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    isCurrent: () => true,
    isBusy: () => false,
    async close() {},
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase, expired: false, spentCents, limitCents: 100 }),
    async () => endpoint,
  );
  assert.equal((await access.connect()).spentCents, 0);
  spentCents = 20;
  assert.equal(access.status()?.spentCents, 20);
  assert.equal(access.status()?.limitCents, 100);
  phase = 'blocked';
  assert.equal(access.status()?.usageUncertain, true);
  await access.close();
});
