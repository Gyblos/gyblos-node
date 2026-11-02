import assert from 'node:assert/strict';
import { test } from 'node:test';

import { opencodeConfig, parsePaypalAgentResult } from '@gyblos/desktop/paypal-agent-model';

void test('OpenCode configuration uses an environment variable instead of embedding the key', () => {
  const config = opencodeConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: 'synthetic-model',
    pending: false,
  });
  assert.match(config, /\{env:GYBLOS_API_KEY\}/);
  assert.match(config, /synthetic-model/);
  assert.doesNotMatch(config, /synthetic-secret-key/);
});

void test('IPC result rejects external connection URLs and malformed keys', () => {
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'a'.repeat(43),
    model: 'synthetic-model',
    pending: false,
  };
  assert.deepEqual(parsePaypalAgentResult({ connection, error: null }).connection, connection);
  assert.equal(parsePaypalAgentResult({ connection: { ...connection, url: 'https://external.invalid/v1' }, error: null }).connection, null);
  assert.equal(parsePaypalAgentResult({ connection: { ...connection, key: 'short' }, error: null }).connection, null);
});
