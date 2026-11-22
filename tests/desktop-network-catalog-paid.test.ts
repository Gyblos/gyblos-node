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

void test('desktop announcements show paid USDC listings apart from free ones, with each seller’s own prices', async () => {
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
      [1, '90000', '150000'],
      [1, '52000', '208000'],
    ],
  );
  assert.deepEqual(parseNetworkCatalog(snapshot), snapshot);
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.deepEqual(
    models.map((model) => [model.free, model.input, model.output]),
    [
      [true, 0, 0],
      [false, 0.09, 0.15],
      [false, 0.052, 0.208],
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

void test('paid listings that charge zero on opposite sides stay separate, never shown as free', async () => {
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
      [false, 1, '0', '500000'],
      [false, 1, '500000', '0'],
    ],
  );
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.deepEqual(
    models.map((model) => model.free),
    [true, false, false],
  );
  assert.equal(new Set(models.map((model) => model.id)).size, 3);
});

void test('an offer handle resolves only to its live seller and terms in the main process', async () => {
  const { createCatalogSession } =
    await import('@gyblos/desktop/network-catalog-session');
  const first = await priced('10', '20');
  const second = await priced('10', '20');
  let now = DISCOVERY_NOW;
  const catalog = createCatalogSession(
    async () => jsonResponse(200, sellersBody([first.signed, second.signed])),
    () => now,
    new AbortController().signal,
  );
  const snapshot = await catalog.lookup('qwen3:0.6b');
  const [a, b] = snapshot.models;
  assert.ok(a?.offerId && b?.offerId);
  assert.notEqual(a.offerId, b.offerId);
  assert.equal(
    catalog.resolve(b.offerId)?.nodeId,
    second.signed.catalog.record.nodeId,
  );
  assert.equal(catalog.resolve('missing'), undefined);
  now = b.expiresAt;
  assert.equal(catalog.resolve(b.offerId), undefined);
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

void test('the buyer validates the selected seller and rejects expired terms before quoting', async () => {
  const { parseBuyerSellerChoice } = await import('@gyblos/protocol/buyer-api');
  const example = await priced('5', '9');
  const { nodeId, owner } = example.signed.catalog.record;
  const choice = {
    nodeId,
    owner,
    modelId: 'qwen3-0.6b',
    variant: null,
    quantization: null,
    contextTokens: 2048,
    inputAtomicPerMtok: '5',
    outputAtomicPerMtok: '9',
    expiresAt: DISCOVERY_NOW + 1,
  };
  assert.deepEqual(parseBuyerSellerChoice(choice, DISCOVERY_NOW), choice);
  assert.throws(() => parseBuyerSellerChoice(choice, choice.expiresAt));
  assert.throws(() =>
    parseBuyerSellerChoice({ ...choice, relayUrl: 'invalid' }, DISCOVERY_NOW),
  );
});

void test('opening chat discovers free and paid sellers of the same model without a lookup', async () => {
  const { createCatalogSession } =
    await import('@gyblos/desktop/network-catalog-session');
  const { announcedModels, chatNetworkOptions, networkModelGroups } =
    await import('@gyblos/desktop/announced-models');
  const free = await priced('0', '0');
  const paid = await priced('52000', '208000');
  const requests: string[] = [];
  const session = createCatalogSession(
    async (url) => {
      requests.push(new URL(url).pathname);
      return new URL(url).pathname.endsWith('/models')
        ? jsonResponse(200, {
            models: [{ id: 'qwen3:0.6b', sellers: 2 }],
            generatedAt: DISCOVERY_NOW,
          })
        : jsonResponse(200, sellersBody([free.signed, paid.signed]));
    },
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  const listings = chatNetworkOptions(
    announcedModels(await session.browse(), DISCOVERY_NOW),
  );
  assert.deepEqual(
    listings.map((row) => [row.name, row.free, row.input, row.output]),
    [
      ['qwen3:0.6b', true, 0, 0],
      ['qwen3:0.6b', false, 0.052, 0.208],
    ],
  );
  assert.equal(
    session.resolve(listings[1]?.offerId ?? '')?.nodeId,
    paid.signed.catalog.record.nodeId,
  );
  const groups = networkModelGroups(listings);
  assert.deepEqual([...groups], [['qwen3:0.6b', listings]]);
  await session.browse();
  assert.deepEqual(requests, ['/v1/models', '/v1/sellers']);
});
