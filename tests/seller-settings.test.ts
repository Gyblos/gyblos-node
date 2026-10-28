// Seller startup reads gyblos.toml: a servable free offer becomes the public listing, a missing or paid
// offer fails closed (paid v1 selling is off until phase 2) and so does anything the daemon cannot honor.
// Offline; files live in a disposable directory and values are synthetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HOSTS } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { parseNodeConfig, type NodeConfig } from '@gyblos/node/node-config';
import { sellerPublicationConfig } from '@gyblos/node/publisher-config';
import { listedPrices } from '@gyblos/node/seller-offer';
import {
  loadSellerSettings,
  sellerSettings,
} from '@gyblos/node/seller-settings';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';

import {
  BASE,
  EXAMPLES_DIRECTORY,
  offer,
} from './support/node-config-fixtures';

const MANAGED = `{ kind = "ollama", url = "${HOSTS.ollama}" }`;
const FREE = 'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }';
const POC_PRICE =
  'price = { input_per_mtok = "1", output_per_mtok = "2", currency = "USDC" }';
const DEFAULT_RELAY = 'https://na1.relay.gyblos.com/';
const PAID_LISTING = {
  modelId: 'qwen3-0.6b',
  reasoning: ['off'],
  kind: 'paid',
  prices: { inputAtomicPerMtok: '1000000', outputAtomicPerMtok: '2000000' },
} as const;
const FREE_LISTING = {
  modelId: 'qwen3-0.6b',
  reasoning: ['off'],
  kind: 'free',
  caps: { dailyTokenCap: 200000, perBuyerCap: 5000 },
} as const;

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
        engine: MANAGED,
        extra: 'reasoning = ["off"]',
        ...fields,
      }),
  );

function rejects(code: string, run: () => unknown, offerIndex?: number) {
  assert.throws(
    run,
    (error) =>
      error instanceof NodeError &&
      error.code === code &&
      (offerIndex === undefined || error.offer === offerIndex),
  );
}
const freeFile = () => served({ pricing: FREE });

void test('without offers the seller refuses to start; nothing runs that the seller did not ask for', () => {
  rejects(NODE_ERROR_CODES.SELLER_OFFERS_MISSING, () =>
    sellerSettings(undefined, {}),
  );
  rejects(NODE_ERROR_CODES.SELLER_OFFERS_MISSING, () =>
    sellerSettings(fileConfig(BASE), {}),
  );
});

void test('a free offer keeps the defaults: no publication, default relays', () => {
  const settings = sellerSettings(freeFile(), {});
  assert.deepEqual(settings.offer, FREE_LISTING);
  assert.equal(settings.relayOnly, false);
  assert.equal(settings.irohBind, undefined);
  assert.equal(settings.irohExternalAddress, undefined);
  assert.equal(settings.publication, undefined);
  assert.equal(
    assertConfiguredRelay(DEFAULT_RELAY, settings.relayEnvironment),
    DEFAULT_RELAY,
  );
  assert.equal(settings.relayEnvironment.GYBLOS_RELAY_TOKEN, undefined);
});

void test('environment-only settings match the previous direct readers', () => {
  const environment = {
    GYBLOS_RELAY_ONLY: '1',
    GYBLOS_RELAY_TOKEN: 'synthetic-relay-token-000000000000',
    GYBLOS_DISCOVERY_PUBLISH: '1',
  };
  const settings = sellerSettings(freeFile(), environment);
  assert.equal(settings.relayOnly, true);
  assert.deepEqual(settings.publication, sellerPublicationConfig(environment));
  assert.equal(
    settings.relayEnvironment.GYBLOS_RELAY_TOKEN,
    environment.GYBLOS_RELAY_TOKEN,
  );
  const direct = sellerSettings(freeFile(), {
    GYBLOS_IROH_BIND: '0.0.0.0:4433',
    GYBLOS_IROH_EXTERNAL_ADDR: '203.0.113.7:4433',
  });
  assert.equal(direct.irohBind, '0.0.0.0:4433');
  assert.equal(direct.irohExternalAddress, '203.0.113.7:4433');
  assert.equal(
    sellerSettings(freeFile(), { GYBLOS_IROH_EXTERNAL_ADDR: '' })
      .irohExternalAddress,
    undefined,
  );
});

void test('a free offer lists zero prices with its caps', () => {
  const settings = sellerSettings(freeFile(), {});
  assert.deepEqual(settings.offer, FREE_LISTING);
  assert.deepEqual(listedPrices(settings.offer), {
    inputAtomicPerMtok: '0',
    outputAtomicPerMtok: '0',
  });
  assert.deepEqual(listedPrices(PAID_LISTING), PAID_LISTING.prices);
});

void test('paid offers fail closed with the offer position: paid v1 selling is off until phase 2', () => {
  for (const file of [served({ pricing: POC_PRICE }), served()])
    rejects(
      NODE_ERROR_CODES.SELLER_PAID_EXECUTION_UNAVAILABLE,
      () => sellerSettings(file, {}),
      0,
    );
});

void test('offers the daemon cannot serve fail closed with a static code', () => {
  rejects(NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED, () =>
    sellerSettings(
      fileConfig(
        BASE + offer({ engine: MANAGED, extra: 'reasoning = ["low"]' }),
      ),
      {},
    ),
  );
  rejects(NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED, () =>
    sellerSettings(
      served({
        pricing: FREE,
        engine: '{ kind = "ollama", url = "http://127.0.0.1:11434" }',
      }),
      {},
    ),
  );
  rejects(NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED, () =>
    sellerSettings(
      served({
        pricing: FREE,
        engine: `{ kind = "ollama", url = "${HOSTS.ollama}", upstream_model = "qwen3:8b" }`,
      }),
      {},
    ),
  );
  rejects(
    NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED,
    () =>
      sellerSettings(
        served({ pricing: FREE, extra: 'reasoning = ["off", "high"]' }),
        {},
      ),
    0,
  );
  const two =
    BASE +
    offer({
      model: 'qwen3:0.6b',
      engine: MANAGED,
      pricing: FREE,
      extra: 'reasoning = ["off"]',
    }) +
    offer({ model: 'gpt-oss-20b', engine: MANAGED });
  rejects(NODE_ERROR_CODES.SELLER_OFFER_COUNT_UNSUPPORTED, () =>
    sellerSettings(fileConfig(two), {}),
  );
});

void test('file keys the daemon does not consume yet are refused unless the environment wins', () => {
  const withHome = fileConfig(
    'version = 1\n[node]\nnetwork = "devnet"\ndata_dir = "/data"\n' +
      offer({
        model: 'qwen3:0.6b',
        engine: MANAGED,
        pricing: FREE,
        extra: 'reasoning = ["off"]',
      }),
  );
  rejects(NODE_ERROR_CODES.SELLER_SETTING_UNSUPPORTED, () =>
    sellerSettings(withHome, {}),
  );
  assert.equal(
    sellerSettings(withHome, { GYBLOS_HOME: '/srv/gyblos' }).relayOnly,
    false,
  );
});

void test('file transport, discovery and relay token variable apply; the environment overrides them', () => {
  const file = fileConfig(
    BASE +
      offer({
        model: 'qwen3:0.6b',
        engine: MANAGED,
        pricing: FREE,
        extra: 'reasoning = ["off"]',
      }) +
      '[relays]\nrelay_token_env = "SYNTHETIC_TOKEN_VAR"\n' +
      '[transport]\nrelay_only = true\n' +
      '[discovery]\npublish = true\nurl = "https://discovery.example.com/v1"\n',
  );
  const settings = sellerSettings(file, {
    SYNTHETIC_TOKEN_VAR: 'synthetic-relay-token-111111111111',
  });
  assert.equal(settings.relayOnly, true);
  assert.deepEqual(settings.publication, {
    baseUrl: 'https://discovery.example.com/v1',
  });
  assert.equal(
    settings.relayEnvironment.GYBLOS_RELAY_TOKEN,
    'synthetic-relay-token-111111111111',
  );
  const overridden = sellerSettings(file, {
    GYBLOS_RELAY_ONLY: '0',
    GYBLOS_DISCOVERY_PUBLISH: '0',
  });
  assert.equal(overridden.relayOnly, false);
  assert.equal(overridden.publication, undefined);
});

void test('invalid environment values for consumed settings fail closed; GYBLOS_RPC_URL is not consumed', () => {
  rejects(NODE_ERROR_CODES.NODE_CONFIG_INVALID, () =>
    sellerSettings(freeFile(), { GYBLOS_DISCOVERY_PUBLISH: 'yes' }),
  );
  rejects(NODE_ERROR_CODES.NODE_CONFIG_INVALID, () =>
    sellerSettings(freeFile(), { GYBLOS_RELAYS: 'http://relay.example.com' }),
  );
  for (const value of ['', 'garbage', 'ftp://x'])
    assert.deepEqual(
      sellerSettings(freeFile(), { GYBLOS_RPC_URL: value }).offer,
      FREE_LISTING,
    );
});

void test('the seller-daemon example starts the seller as written', () => {
  const settings = sellerSettings(
    fileConfig(
      readFileSync(join(EXAMPLES_DIRECTORY, 'seller-daemon.toml'), 'utf8'),
    ),
    {},
  );
  assert.deepEqual(settings.offer, FREE_LISTING);
  assert.equal(settings.publication, undefined);
});

void test('loadSellerSettings: optional ./gyblos.toml, required GYBLOS_CONFIG, invalid files fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-seller-settings-'));
  try {
    await rejectsAsync(NODE_ERROR_CODES.SELLER_OFFERS_MISSING, () =>
      loadSellerSettings({}, directory),
    );
    await rejectsAsync(NODE_ERROR_CODES.NODE_CONFIG_INVALID, () =>
      loadSellerSettings({ GYBLOS_CONFIG: 'missing.toml' }, directory),
    );
    const freeToml =
      BASE +
      offer({
        model: 'qwen3:0.6b',
        engine: MANAGED,
        pricing: FREE,
        extra: 'reasoning = ["off"]',
      });
    await writeFile(join(directory, 'gyblos.toml'), freeToml);
    assert.equal((await loadSellerSettings({}, directory)).offer.kind, 'free');
    await writeFile(join(directory, 'other.toml'), 'version = 1\n[node\n');
    await rejectsAsync(NODE_ERROR_CODES.NODE_CONFIG_INVALID, () =>
      loadSellerSettings({ GYBLOS_CONFIG: 'other.toml' }, directory),
    );
    await writeFile(join(directory, 'gyblos.toml'), 'version = 1\n[node\n');
    await rejectsAsync(NODE_ERROR_CODES.NODE_CONFIG_INVALID, () =>
      loadSellerSettings({}, directory),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function rejectsAsync(code: string, run: () => Promise<unknown>) {
  await assert.rejects(
    run,
    (error) => error instanceof NodeError && error.code === code,
  );
}
