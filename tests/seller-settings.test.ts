// Seller startup reads gyblos.toml: environment-only startup is unchanged, a servable offer becomes the
// public listing (paid PoC rates or free caps) and anything the daemon cannot honor fails closed.
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
import { defaultSellerOffer, listedPrices } from '@gyblos/node/seller-offer';
import {
  loadSellerSettings,
  sellerSettings,
} from '@gyblos/node/seller-settings';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';

import {
  BASE,
  EXAMPLES_DIRECTORY,
  offer,
} from './support/node-config-fixtures.js';

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

function rejects(code: string, run: () => unknown) {
  assert.throws(
    run,
    (error) => error instanceof NodeError && error.code === code,
  );
}

void test('without a file the seller keeps today: PoC listing, no publication, default relays', () => {
  const settings = sellerSettings(undefined, {});
  assert.deepEqual(settings.offer, PAID_LISTING);
  assert.deepEqual(settings.offer, defaultSellerOffer());
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
  const settings = sellerSettings(undefined, environment);
  assert.equal(settings.relayOnly, true);
  assert.deepEqual(settings.publication, sellerPublicationConfig(environment));
  assert.equal(
    settings.relayEnvironment.GYBLOS_RELAY_TOKEN,
    environment.GYBLOS_RELAY_TOKEN,
  );
  const direct = sellerSettings(undefined, {
    GYBLOS_IROH_BIND: '0.0.0.0:4433',
    GYBLOS_IROH_EXTERNAL_ADDR: '203.0.113.7:4433',
  });
  assert.equal(direct.irohBind, '0.0.0.0:4433');
  assert.equal(direct.irohExternalAddress, '203.0.113.7:4433');
  assert.equal(
    sellerSettings(undefined, { GYBLOS_IROH_EXTERNAL_ADDR: '' })
      .irohExternalAddress,
    undefined,
  );
});

void test('a free offer is refused until free execution is wired, then lists zero prices with its caps', () => {
  rejects(NODE_ERROR_CODES.SELLER_FREE_EXECUTION_UNAVAILABLE, () =>
    sellerSettings(served({ pricing: FREE }), {}),
  );
  const settings = sellerSettings(
    served({ pricing: FREE }),
    {},
    { freeExecution: true },
  );
  assert.deepEqual(settings.offer, {
    modelId: 'qwen3-0.6b',
    reasoning: ['off'],
    kind: 'free',
    caps: { dailyTokenCap: 200000, perBuyerCap: 5000 },
  });
  assert.deepEqual(listedPrices(settings.offer), {
    inputAtomicPerMtok: '0',
    outputAtomicPerMtok: '0',
  });
  assert.deepEqual(listedPrices(PAID_LISTING), PAID_LISTING.prices);
});

void test('a paid offer must advertise exactly the PoC rates the v1 path charges', () => {
  assert.deepEqual(
    sellerSettings(served({ pricing: POC_PRICE }), {}).offer,
    PAID_LISTING,
  );
  rejects(NODE_ERROR_CODES.SELLER_OFFER_PRICE_UNSUPPORTED, () =>
    sellerSettings(served(), {}),
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
  rejects(NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED, () =>
    sellerSettings(
      served({ pricing: FREE, extra: 'reasoning = ["off", "high"]' }),
      {},
    ),
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
    'version = 1\n[node]\nnetwork = "devnet"\ndata_dir = "/data"\n',
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
    sellerSettings(undefined, { GYBLOS_DISCOVERY_PUBLISH: 'yes' }),
  );
  rejects(NODE_ERROR_CODES.NODE_CONFIG_INVALID, () =>
    sellerSettings(undefined, { GYBLOS_RELAYS: 'http://relay.example.com' }),
  );
  for (const value of ['', 'garbage', 'ftp://x'])
    assert.deepEqual(
      sellerSettings(undefined, { GYBLOS_RPC_URL: value }).offer,
      PAID_LISTING,
    );
});

void test('the seller-daemon example starts the seller as written', () => {
  const settings = sellerSettings(
    fileConfig(
      readFileSync(join(EXAMPLES_DIRECTORY, 'seller-daemon.toml'), 'utf8'),
    ),
    {},
  );
  assert.deepEqual(settings.offer, PAID_LISTING);
  assert.equal(settings.publication, undefined);
});

void test('loadSellerSettings: optional ./gyblos.toml, required GYBLOS_CONFIG, invalid files fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-seller-settings-'));
  try {
    assert.deepEqual(
      (await loadSellerSettings({}, directory)).offer,
      PAID_LISTING,
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
    await rejectsAsync(NODE_ERROR_CODES.SELLER_FREE_EXECUTION_UNAVAILABLE, () =>
      loadSellerSettings({}, directory),
    );
    assert.equal(
      (await loadSellerSettings({}, directory, { freeExecution: true })).offer
        .kind,
      'free',
    );
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
