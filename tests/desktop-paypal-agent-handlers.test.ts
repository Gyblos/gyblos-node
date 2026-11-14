import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalAgentHandlers } from '@gyblos/desktop/paypal-agent-handlers';
import { PAYPAL_AGENT_USAGE_STATE } from '@gyblos/desktop/paypal-agent-model';

void test('only the desktop main frame can request agent connection details', async () => {
  const contents = {};
  const frame = {};
  let loads = 0;
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    model: 'synthetic-model',
    spentCents: 0,
    limitCents: 100,
    keyLimitCents: 100,
    keySpentCents: 0,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  const access = {
    status: () => connection,
    async connect() {
      return connection;
    },
    copyKey: () => false,
    async disconnect() {},
    async close() {},
  };
  const handlers = createDesktopPaypalAgentHandlers(
    async () => {
      loads += 1;
      return { agentAccess: access };
    },
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const denied = await handlers.run({ sender: {}, senderFrame: frame }, [
    { action: 'connect', limitCents: 100 },
  ]);
  assert.equal(denied.connection, null);
  assert.equal(loads, 0);
  const allowed = await handlers.run({ sender: contents, senderFrame: frame }, [
    { action: 'connect', limitCents: 100 },
  ]);
  assert.deepEqual(allowed.connection, connection);
  assert.equal(loads, 1);
  const invalid = await handlers.run({ sender: contents, senderFrame: frame }, [
    { action: 'connect', limitCents: 100, extra: true },
  ]);
  assert.equal(invalid.connection, null);
  assert.equal(loads, 1);
});

void test('checking agent status does not start the PayPal service', async () => {
  const contents = {};
  const frame = {};
  let loads = 0;
  const handlers = createDesktopPaypalAgentHandlers(
    async () => {
      loads += 1;
      throw new Error('must not load');
    },
    { contents, mainFrame: () => frame, destroyed: () => false },
    () => null,
  );
  const result = await handlers.run({ sender: contents, senderFrame: frame }, [
    { action: 'status' },
  ]);
  assert.deepEqual(result, { connection: null, error: null });
  assert.equal(loads, 0);
});

void test('only a valid explicit key limit can create API access through IPC', async () => {
  const contents = {};
  const frame = {};
  let granted: number | undefined;
  let loads = 0;
  const access = {
    status: () => null,
    async connect(limit?: number) {
      granted = limit;
      throw new Error('synthetic stop before creating a key');
    },
    copyKey: () => false,
    async disconnect() {},
    async close() {},
  };
  const handlers = createDesktopPaypalAgentHandlers(
    async () => {
      loads += 1;
      return { agentAccess: access };
    },
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const event = { sender: contents, senderFrame: frame };
  for (const request of [
    { action: 'connect' },
    { action: 'connect', limitCents: '20' },
    { action: 'connect', limitCents: 15 },
    { action: 'connect', limitCents: 0 },
    { action: 'connect', limitCents: 1001 },
    { action: 'connect', limitCents: 20, extra: true },
    { action: 'status', limitCents: 20 },
  ])
    assert.equal((await handlers.run(event, [request])).error, 'invalid');
  assert.equal(loads, 0);
  await handlers.run(event, [{ action: 'connect', limitCents: 20 }]);
  assert.equal(granted, 20);
  assert.equal(loads, 1);
});
