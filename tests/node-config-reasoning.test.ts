// Owns the gyblos.toml reasoning contract: catalog models accept only their verified levels and default to
// their catalog level; custom and unverified models accept any levels with a warning. Offline; synthetic inputs.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseNodeConfig,
  type NodeConfigResult,
} from '@gyblos/node/node-config';

import { BASE, offer } from './support/node-config-fixtures.js';

function issuesOf(result: NodeConfigResult) {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

void test('a catalog model refuses reasoning levels it does not support', () => {
  // gpt-oss has low/medium/high effort and no off switch.
  assert.deepEqual(
    issuesOf(
      parseNodeConfig(
        BASE + offer({ extra: 'reasoning = ["off", "low", "medium"]' }),
      ),
    ),
    [{ code: 'REASONING_UNSUPPORTED', path: 'offers[0].reasoning[0]' }],
  );
  // Qwen3 thinking is on/off, mapped to off and high (GYB-DOC-028).
  assert.deepEqual(
    issuesOf(
      parseNodeConfig(
        BASE +
          offer({
            model: 'qwen3:30b-a3b',
            extra: 'reasoning = ["off", "low", "medium", "high"]',
          }),
      ),
    ),
    [
      { code: 'REASONING_UNSUPPORTED', path: 'offers[0].reasoning[1]' },
      { code: 'REASONING_UNSUPPORTED', path: 'offers[0].reasoning[2]' },
    ],
  );
  assert.deepEqual(
    issuesOf(
      parseNodeConfig(
        BASE + offer({ model: 'llama-3.3-70b', extra: 'reasoning = ["high"]' }),
      ),
    ),
    [{ code: 'REASONING_UNSUPPORTED', path: 'offers[0].reasoning[0]' }],
  );
});

void test('omitted reasoning uses the catalog model default level', () => {
  const result = parseNodeConfig(
    BASE +
      offer({ model: 'gpt-oss-20b' }) +
      offer({ model: 'qwen3:0.6b' }) +
      offer({ model: 'llama-3.3-70b' }) +
      offer({ model: 'gemma-4-26b' }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.config.offers.map((entry) => entry.reasoning),
    [['medium'], ['off'], ['off'], ['off']],
  );
  assert.deepEqual(result.warnings, []);
});

void test('unverified catalog models and custom models accept any levels with a warning', () => {
  const result = parseNodeConfig(
    BASE +
      offer({ model: 'kimi-k3', extra: 'reasoning = ["off", "low"]' }) +
      offer({ model: 'deepseek-v4.1-flash' }) +
      offer({ model: 'acme/chat-large', extra: 'custom = true' }) +
      offer({ model: 'gpt-oss-120b', extra: 'reasoning = ["high"]' }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.config.offers.map((entry) => entry.reasoning),
    [['off', 'low'], ['off'], ['off'], ['high']],
  );
  assert.deepEqual(result.warnings, [
    { code: 'REASONING_UNVERIFIED', path: 'offers[0].reasoning' },
    { code: 'REASONING_UNVERIFIED', path: 'offers[1].reasoning' },
    { code: 'REASONING_UNVERIFIED', path: 'offers[2].reasoning' },
  ]);
});
