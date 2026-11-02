import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  opencodeConfig,
  paypalAgentStatusUnavailable,
  PAYPAL_AGENT_ACTION,
  parsePaypalAgentResult,
  PAYPAL_AGENT_USAGE_STATE,
  retainPaypalAgentStatus,
} from '@gyblos/desktop/paypal-agent-model';

void test('OpenCode configuration uses an environment variable instead of embedding the key', () => {
  const config = opencodeConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: 'synthetic-model',
  });
  assert.match(config, /\{env:GYBLOS_API_KEY\}/);
  assert.match(config, /synthetic-model/);
  assert.doesNotMatch(config, /synthetic-secret-key/);
  const parsed: unknown = JSON.parse(config);
  assert.ok(parsed && typeof parsed === 'object' && 'provider' in parsed);
  assert.ok('model' in parsed);
  assert.equal(parsed.model, 'gyblos/synthetic-model');
  assert.ok(
    'agent' in parsed &&
      parsed.agent &&
      typeof parsed.agent === 'object' &&
      'title' in parsed.agent,
  );
  assert.deepEqual(parsed.agent.title, { disable: true });
  assert.ok(
    parsed.provider &&
      typeof parsed.provider === 'object' &&
      'gyblos' in parsed.provider,
  );
  assert.ok(
    parsed.provider.gyblos &&
      typeof parsed.provider.gyblos === 'object' &&
      'models' in parsed.provider.gyblos,
  );
  assert.ok(
    parsed.provider.gyblos.models &&
      typeof parsed.provider.gyblos.models === 'object' &&
      'synthetic-model' in parsed.provider.gyblos.models,
  );
  assert.deepEqual(parsed.provider.gyblos.models['synthetic-model'], {
    name: 'synthetic-model',
    tool_call: true,
    limit: { context: 8192, output: 512 },
  });
});

void test('a confirmed disconnect clears an older stalled status warning', () => {
  const disconnected = { connection: null, error: null };
  assert.equal(paypalAgentStatusUnavailable(PAYPAL_AGENT_ACTION.DISCONNECT, disconnected, true), false);
  assert.equal(paypalAgentStatusUnavailable(PAYPAL_AGENT_ACTION.CONNECT, disconnected, true), true);
  assert.equal(paypalAgentStatusUnavailable(PAYPAL_AGENT_ACTION.DISCONNECT, undefined, true), true);
});

void test('a failed status check preserves an existing connection until status is known', () => {
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'a'.repeat(43),
    model: 'synthetic-model',
    spentCents: 20,
    limitCents: 100,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  const previous = { connection, error: null };
  const unknown = retainPaypalAgentStatus(previous, undefined);
  assert.deepEqual(unknown, { result: previous, unavailable: true });
  const recovered = retainPaypalAgentStatus(previous, {
    connection: null,
    error: null,
  });
  assert.deepEqual(recovered, {
    result: { connection: null, error: null },
    unavailable: false,
  });
});

void test('IPC result rejects external connection URLs and malformed keys', () => {
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'a'.repeat(43),
    model: 'synthetic-model',
    spentCents: 0,
    limitCents: 100,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  assert.deepEqual(
    parsePaypalAgentResult({ connection, error: null }).connection,
    connection,
  );
  assert.equal(
    parsePaypalAgentResult({
      connection: { ...connection, url: 'https://external.invalid/v1' },
      error: null,
    }).connection,
    null,
  );
  assert.equal(
    parsePaypalAgentResult({
      connection: { ...connection, key: 'short' },
      error: null,
    }).connection,
    null,
  );
});
