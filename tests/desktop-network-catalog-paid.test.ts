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
      // Each price is the lowest among the paid listings, even from different sellers.
      [2, '52000', '150000'],
    ],
  );
  assert.deepEqual(parseNetworkCatalog(snapshot), snapshot);
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.deepEqual(
    models.map((model) => [model.free, model.input, model.output]),
    [
      [true, 0, 0],
      [false, 0.052, 0.15],
    ],
  );
  assert.notEqual(models[0]?.id, models[1]?.id);
  // A price that is not canonical decimal text breaks the IPC contract.
  assert.equal(
    parseNetworkCatalog({
      ...snapshot,
      models: [{ ...snapshot.models[1], inputAtomicPerMtok: '0x10' }],
    }).state,
    CATALOG_STATE.ERROR,
  );
});
