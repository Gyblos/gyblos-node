// The seller's Ollama offer names its own engine URL: only literal loopback origins (127.0.0.1 or [::1])
// on a real port pass; names, paths, other schemes, keys and other plugins are refused with the offer
// position. Offline; values are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { parseNodeConfig, type NodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';

import { BASE, offer } from './support/node-config-fixtures';

const FREE = 'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }';

function fileConfig(toml: string): NodeConfig {
  const result = parseNodeConfig(toml);
  assert.ok(result.ok, JSON.stringify(result));
  return result.config;
}

const served = (fields: Parameters<typeof offer>[0] = {}) =>
  fileConfig(
    BASE +
      offer({
        model: 'qwen3:0.6b',
        extra: 'reasoning = ["off"]',
        ...fields,
      }),
  );

function rejects(code: string, run: () => unknown, offerIndex: number) {
  assert.throws(
    run,
    (error) =>
      error instanceof NodeError &&
      error.code === code &&
      error.offer === offerIndex,
  );
}

void test('an ollama offer may use any literal loopback URL; names, paths and keys are refused', () => {
  const engineOf = (url: string, extra = '') =>
    served({
      pricing: FREE,
      engine: `{ kind = "ollama", url = "${url}"${extra} }`,
    });
  for (const url of [
    'http://127.0.0.1:11434/',
    'http://127.0.0.1:11434',
    'http://[::1]:11434/',
    // Numeric spellings of 127.0.0.1 normalize to it, so they still stay on loopback.
    'http://127.1:11434/',
  ])
    assert.equal(
      sellerSettings(engineOf(url), {}).offers[0]!.engine.engine.url,
      url,
    );
  for (const url of [
    'http://localhost:11434/',
    'http://host.docker.internal:11434/',
    'http://127.0.0.1:11434/ollama',
    'http://127.0.0.1:0/',
    'https://127.0.0.1:11434/',
  ])
    rejects(
      NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
      () => sellerSettings(engineOf(url), {}),
      0,
    );
  // Other plain-http hosts and credentials never get past the file parser.
  for (const url of [
    'http://0.0.0.0:11434/',
    'http://[::ffff:127.0.0.1]:11434/',
    'http://127.0.0.2:11434/',
    'http://user:pass@127.0.0.1:11434/',
  ])
    assert.equal(
      parseNodeConfig(
        BASE +
          offer({
            model: 'qwen3:0.6b',
            engine: `{ kind = "ollama", url = "${url}" }`,
            pricing: FREE,
            extra: 'reasoning = ["off"]',
          }),
      ).ok,
      false,
      url,
    );
  rejects(
    NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
    () =>
      sellerSettings(
        engineOf('http://127.0.0.1:11434/', ', api_key_env = "OLLAMA_KEY"'),
        {},
      ),
    0,
  );
  rejects(
    NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
    () =>
      sellerSettings(
        served({
          pricing: FREE,
          engine:
            '{ kind = "anthropic", url = "https://api.example.com", context_tokens = 131072 }',
        }),
        {},
      ),
    0,
  );
  rejects(
    NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED,
    () =>
      sellerSettings(
        served({
          model: 'gpt-oss-20b',
          pricing: FREE,
          engine: '{ kind = "ollama", url = "http://127.0.0.1:11434/" }',
          extra: 'reasoning = ["low"]',
        }),
        {},
      ),
    0,
  );
  rejects(
    NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED,
    () =>
      sellerSettings(
        served({
          pricing: FREE,
          engine: '{ kind = "ollama", url = "http://127.0.0.1:11434/" }',
          extra: 'reasoning = ["off", "high"]',
        }),
        {},
      ),
    0,
  );
});
