import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canCreatePaypalAgent,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentConnectionLabel,
  paypalAgentNeedsPayments,
  type PaypalAgentResult,
} from '@gyblos/desktop/paypal-agent-model';
import { paypalSessionCanConnectAgent } from '@gyblos/desktop/paypal-model';

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
  assert.equal(canCreatePaypalAgent(null, false, false, false, true), true);
  assert.equal(canCreatePaypalAgent(null, true, false, false, true), false);
  assert.equal(canCreatePaypalAgent(null, false, true, false, true), false);
  assert.equal(canCreatePaypalAgent(null, false, false, true, true), false);
});

void test('agent setup requires a fresh and usable PayPal session', () => {
  const active = {
    phase: 'active' as const,
    expired: false,
    remainingAttempts: 1,
    spentCents: 20,
    limitCents: 100,
  };
  assert.equal(paypalSessionCanConnectAgent(null, true, false), false);
  assert.equal(paypalSessionCanConnectAgent(active, false, false), false);
  assert.equal(paypalSessionCanConnectAgent(active, true, true), false);
  assert.equal(paypalSessionCanConnectAgent(active, true, false), true);
  for (const phase of ['review', 'capturing', 'voiding', 'completed'] as const)
    assert.equal(
      paypalSessionCanConnectAgent({ ...active, phase }, true, false),
      false,
    );
  assert.equal(
    paypalSessionCanConnectAgent({ ...active, expired: true }, true, false),
    false,
  );
  assert.equal(
    paypalSessionCanConnectAgent(
      { ...active, remainingAttempts: 0 },
      true,
      false,
    ),
    false,
  );
  assert.equal(
    paypalSessionCanConnectAgent({ ...active, spentCents: 100 }, true, false),
    false,
  );
  assert.equal(canCreatePaypalAgent(null, false, false, false, false), false);
  assert.equal(canCreatePaypalAgent(null, false, false, false, true), true);
});

void test('agent setup guides missing or unusable payment sessions to Payments', () => {
  assert.equal(paypalAgentNeedsPayments(null, false, false), true);
  assert.equal(paypalAgentNeedsPayments(null, true, false), true);
  assert.equal(paypalAgentNeedsPayments(null, true, true), true);
  assert.equal(paypalAgentNeedsPayments(null, false, true), false);
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
  assert.equal(paypalAgentNeedsPayments(connection, false, false), false);
  assert.equal(paypalAgentNeedsPayments(connection, false, true), false);
});

void test('retained API details are ready only with confirmed usable connection status', async () => {
  const model = await import('@gyblos/desktop/paypal-agent-model');
  assert.equal(typeof model.paypalAgentIsReady, 'function');
  const connection: NonNullable<PaypalAgentResult['connection']> = {
    url: 'http://127.0.0.1:1234/v1', key: 'synthetic-key', model: 'synthetic-model',
    spentCents: 20, limitCents: 100, usageUncertain: false, disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  assert.equal(model.paypalAgentIsReady(connection, false, false), true);
  assert.equal(model.paypalAgentIsReady(null, false, false), false);
  assert.equal(model.paypalAgentIsReady(connection, false, true), false);
  assert.equal(model.paypalAgentIsReady(connection, true, false), false);
  for (const state of Object.values(PAYPAL_AGENT_USAGE_STATE)) {
    if (state === PAYPAL_AGENT_USAGE_STATE.AVAILABLE) continue;
    assert.equal(model.paypalAgentIsReady({ ...connection, usageUncertain: true, usageState: state, disconnecting: state === PAYPAL_AGENT_USAGE_STATE.DISCONNECTING }, false, false), false);
  }
});
