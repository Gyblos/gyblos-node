// `gyblos doctor` with a remote engine: offline it never calls the provider and says so, `--online`
// describes the model with the API key, an unset key variable fails config without echoing anything,
// and a seller whose offers are all declared needs no tokenizer. Synthetic homes and a fake fetch; no
// real provider or key.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { doctor, line, scenario, type Fixture } from './support/doctor-fixture';
import { FAKE_SECRET } from './support/node-config-fixtures';

const KEY = { UPSTREAM_API_KEY: `${FAKE_SECRET}-api-key` };
const remoteToml = () =>
  [
    'version = 1',
    '[node]',
    'network = "devnet"',
    '[[offers]]',
    'model = "acme/chat-small"',
    'custom = true',
    'reasoning = ["off"]',
    'engine = { kind = "openai", url = "https://api.example.com/v1", api_key_env = "UPSTREAM_API_KEY", upstream_model = "acme-chat-small-2026", context_tokens = 131072 }',
    'free = { daily_token_cap = 20000, per_buyer_cap = 2000 }',
    '',
  ].join('\n');

function provider() {
  const requests: { url: string; authorized: boolean }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorized:
        new Headers(init?.headers).get('authorization') ===
        `Bearer ${KEY.UPSTREAM_API_KEY}`,
    });
    return new Response(
      JSON.stringify({ data: [{ id: 'acme-chat-small-2026' }] }),
    );
  };
  return { fetch, requests };
}

async function remote(run: Fixture) {
  await writeFile(join(run.root, 'gyblos.toml'), remoteToml());
}

void test('doctor: offline, a remote engine is not called and is reported as not checked', () =>
  scenario({}, async (run) => {
    await remote(run);
    const upstream = provider();
    const result = await doctor(run, [], KEY, {
      fetch: upstream.fetch,
      tokenizer: undefined,
    });
    assert.equal(result.code, 0, result.output);
    assert.match(
      line(result.output, 'engine[1]'),
      /WARN\s+engine\[1\]\s+REMOTE_ENGINE_NOT_CHECKED\s+.*--online/,
    );
    assert.deepEqual(upstream.requests, []);
    // Every offer is declared, so no tokenizer is needed.
    assert.match(
      line(result.output, 'tokenizer'),
      /OK\s+tokenizer\s+NOT_NEEDED/,
    );
  }));

void test('doctor --online describes a remote engine with its key, never generating', () =>
  scenario({}, async (run) => {
    await remote(run);
    const upstream = provider();
    const result = await doctor(run, ['--online'], KEY, {
      fetch: upstream.fetch,
    });
    assert.equal(result.code, 0, result.output);
    assert.match(line(result.output, 'engine[1]'), /^\s*OK\s+engine\[1\]/);
    assert.deepEqual(upstream.requests, [
      { url: 'https://api.example.com/v1/models', authorized: true },
    ]);
  }));

void test('doctor: an unset API key variable fails config for its offer without naming a value', () =>
  scenario({}, async (run) => {
    await remote(run);
    const upstream = provider();
    const result = await doctor(
      run,
      ['--online'],
      {},
      { fetch: upstream.fetch },
    );
    assert.equal(result.code, 1);
    assert.match(
      line(result.output, 'config'),
      /FAIL\s+config\s+SELLER_OFFER_API_KEY_MISSING\s+\[\[offers\]\] entry 1: set the variable named by api_key_env/,
    );
    assert.deepEqual(upstream.requests, []);
  }));
