import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalAgentHandlers } from '@gyblos/desktop/paypal-agent-handlers';

void test('only the desktop main frame can request agent connection details', async () => {
  const contents = {};
  const frame = {};
  let loads = 0;
  const connection = { url: 'http://127.0.0.1:12345/v1', key: 'synthetic-key', model: 'synthetic-model', pending: false };
  const access = {
    status: () => connection,
    async connect() { return connection; },
    async confirm() {},
    async disconnect() {},
    async close() {},
  };
  const handlers = createDesktopPaypalAgentHandlers(
    async () => { loads += 1; return { agentAccess: access }; },
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const denied = await handlers.run({ sender: {}, senderFrame: frame }, [{ action: 'connect' }]);
  assert.equal(denied.connection, null);
  assert.equal(loads, 0);
  const allowed = await handlers.run({ sender: contents, senderFrame: frame }, [{ action: 'connect' }]);
  assert.deepEqual(allowed.connection, connection);
  assert.equal(loads, 1);
  const invalid = await handlers.run({ sender: contents, senderFrame: frame }, [{ action: 'connect', extra: true }]);
  assert.equal(invalid.connection, null);
  assert.equal(loads, 1);
});
