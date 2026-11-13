// Legacy sandbox connection status shares the desktop rule: credentials stay in the main process.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalAgentAccess } from '@gyblos/desktop/paypal-agent-access';
import { createDesktopPaypalAgentHandlers } from '@gyblos/desktop/paypal-agent-handlers';
import {
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_COPY,
} from '@gyblos/desktop/paypal-agent-model';
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

void test('sandbox connect and status never carry its private token, while native copy still works', async () => {
  const secret = 'synthetic-private-sandbox-token';
  const access = createDesktopPaypalAgentAccess(
    () => ({
      phase: PAYPAL_SESSION_PHASE.ACTIVE,
      expired: false,
      spentCents: 0,
      limitCents: 100,
      remainingAttempts: 10,
    }),
    async () => ({
      url: 'http://127.0.0.1:12345/v1',
      key: secret,
      model: 'synthetic',
      isCurrent: () => true,
      isBusy: () => false,
      close: async () => {},
      budget: () => ({ keyLimitCents: 100, keySpentCents: 0, token: secret }),
    }),
  );
  const contents = {};
  const frame = {};
  let copied = '';
  const host = createDesktopPaypalAgentHandlers(
    async () => ({ agentAccess: access }),
    { contents, mainFrame: () => frame, destroyed: () => false },
    () => ({ agentAccess: access }),
    (text) => {
      copied = text;
    },
  );
  const event = { sender: contents, senderFrame: frame };
  try {
    const connected = await host.run(event, [
      { action: PAYPAL_AGENT_ACTION.CONNECT, limitCents: 100 },
    ]);
    assert.ok(connected.connection);
    assert.ok(!JSON.stringify(connected).includes(secret));
    assert.ok(!Object.hasOwn(connected.connection, 'key'));
    const status = await host.run(event, [
      { action: PAYPAL_AGENT_ACTION.STATUS },
    ]);
    assert.ok(!JSON.stringify(status).includes(secret));
    assert.equal(
      await host.copy(event, [{ target: PAYPAL_AGENT_COPY.KEY }]),
      true,
    );
    assert.equal(copied, secret);
    assert.equal(
      await host.copy({ ...event, senderFrame: {} }, [
        { target: PAYPAL_AGENT_COPY.KEY },
      ]),
      false,
    );
  } finally {
    await access.close();
  }
});
