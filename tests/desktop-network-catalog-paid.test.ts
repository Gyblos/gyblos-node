// Paid listings priced in devnet USDC appear in the desktop catalog next to free ones, grouped apart, each
// group with its cheapest price. Signed synthetic announcements; no real index, wallets or inference.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import {
  CATALOG_STATE,
  parseNetworkCatalog,
} from '@gyblos/desktop/network-catalog';
import { readAnnouncements } from '@gyblos/desktop/network-catalog-reader';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import {
  DISCOVERY_NOW,
  discoverySeller,
  jsonResponse,
  sellersBody,
} from './support/discovery-fixture';

// One seller of qwen3:0.6b at this price, in atomic devnet USDC per million tokens.
async function priced(input: string, output: string) {
  const source = await discoverySeller({ modelId: 'qwen3:0.6b' });
  const catalog = {
    ...source.catalog,
    models: source.catalog.models.map((model) => ({
      ...model,
      pricing: {
        ...model.pricing,
        network: DEVNET,
        asset: DEVNET_USDC,
        inputAtomicPerMtok: input,
        outputAtomicPerMtok: output,
      },
    })),
  };
  return {
    signed: {
      catalog: await signPublicV2(catalog, source.signer),
      presence: await source.presenceFor(catalog),
    },
  };
}

void test('desktop announcements show paid USDC listings apart from free ones, with the cheapest price', async () => {
  const { announcedModels } = await import('@gyblos/desktop/announced-models');
  const free = await priced('0', '0');
  const pricey = await priced('90000', '150000');
  const cheap = await priced('52000', '208000');
  const snapshot = await readAnnouncements(
    async () =>
      jsonResponse(
        200,
        sellersBody([free.signed, pricey.signed, cheap.signed]),
      ),
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.equal(snapshot.state, CATALOG_STATE.READY);
  assert.deepEqual(
    snapshot.models.map((model) => [
      model.announcements,
      model.inputAtomicPerMtok,
      model.outputAtomicPerMtok,
    ]),
    [
      [1, '0', '0'],
      // One real listing's price: the cheapest by input plus output (240000 < 260000).
      [2, '90000', '150000'],
    ],
  );
  assert.deepEqual(parseNetworkCatalog(snapshot), snapshot);
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.deepEqual(
    models.map((model) => [model.free, model.input, model.output]),
    [
      [true, 0, 0],
      [false, 0.09, 0.15],
    ],
  );
  assert.notEqual(models[0]?.id, models[1]?.id);
  // A price that is not canonical decimal text, or a free flag that disagrees with the price, breaks the
  // IPC contract.
  assert.equal(
    parseNetworkCatalog({
      ...snapshot,
      models: [{ ...snapshot.models[1], free: true }],
    }).state,
    CATALOG_STATE.ERROR,
  );
  assert.equal(
    parseNetworkCatalog({
      ...snapshot,
      models: [{ ...snapshot.models[1], inputAtomicPerMtok: '0x10' }],
    }).state,
    CATALOG_STATE.ERROR,
  );
});

void test('paid listings that charge zero on opposite sides stay one paid group, never shown as free', async () => {
  const { announcedModels } = await import('@gyblos/desktop/announced-models');
  const free = await priced('0', '0');
  const outputOnly = await priced('0', '500000');
  const inputOnly = await priced('500000', '0');
  const snapshot = await readAnnouncements(
    async () =>
      jsonResponse(
        200,
        sellersBody([free.signed, outputOnly.signed, inputOnly.signed]),
      ),
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.deepEqual(
    snapshot.models.map((model) => [
      model.free,
      model.announcements,
      model.inputAtomicPerMtok,
      model.outputAtomicPerMtok,
    ]),
    [
      [true, 1, '0', '0'],
      // The first of two equally priced listings is kept whole; sides are never mixed into "0" and "0".
      [false, 2, '0', '500000'],
    ],
  );
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.deepEqual(
    models.map((model) => model.free),
    [true, false],
  );
  assert.equal(new Set(models.map((model) => model.id)).size, 2);
});

void test('a paid price too small for two decimals keeps its digits instead of reading $0.00', async () => {
  const { usdPerMtok, priceRange } =
    await import('@gyblos/desktop/model-price');
  assert.equal(usdPerMtok(0), '$0.00');
  assert.equal(usdPerMtok(0.12), '$0.12');
  assert.equal(usdPerMtok(0.004999), '$0.004999');
  assert.equal(usdPerMtok(0.000001), '$0.000001');
  assert.equal(priceRange({ input: 0.0001, output: 0.15 }), '$0.0001 / $0.15');
});
