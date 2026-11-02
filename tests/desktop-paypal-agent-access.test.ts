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
    hasPending: () => false,
    async acknowledgePending() {},
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase, expired: false }),
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

void test('a pending agent response must be confirmed before disconnect', async () => {
  let pending = true;
  let closed = 0;
  const endpoint = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    hasPending: () => pending,
    async acknowledgePending() {
      pending = false;
    },
    async close() {
      closed += 1;
    },
  };
  const access = createDesktopPaypalAgentAccess(
    () => ({ phase: 'active', expired: false }),
    async () => endpoint,
  );
  await access.connect();
  await assert.rejects(access.disconnect());
  assert.equal(closed, 0);
  await access.confirm();
  await access.disconnect();
  assert.equal(closed, 1);
});
