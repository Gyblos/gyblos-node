import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canCreatePaypalAgent,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentConnectionLabel,
  type PaypalAgentResult,
} from '@gyblos/desktop/paypal-agent-model';

void test('agent connection labels do not present uncertain usage as ready', () => {
  const connection: NonNullable<PaypalAgentResult['connection']> = {
    url: 'http://127.0.0.1:1234/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    spentCents: 30,
    limitCents: 100,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  assert.equal(
    paypalAgentConnectionLabel(null, false, false),
    'No local connection',
  );
  assert.equal(
    paypalAgentConnectionLabel(connection, false, false),
    'Local connection active',
  );
  assert.equal(
    paypalAgentConnectionLabel(
      { ...connection, usageUncertain: true },
      false,
      false,
    ),
    'Session needs attention',
  );
  assert.equal(
    paypalAgentConnectionLabel(connection, false, true),
    'Connection status unavailable',
  );
  assert.equal(
    paypalAgentConnectionLabel(connection, true, false),
    'Checking connection',
  );
});

void test('a local connection cannot be created while its status is unknown', () => {
  assert.equal(canCreatePaypalAgent(null, false, false, false), true);
  assert.equal(canCreatePaypalAgent(null, true, false, false), false);
  assert.equal(canCreatePaypalAgent(null, false, true, false), false);
  assert.equal(canCreatePaypalAgent(null, false, false, true), false);
});
