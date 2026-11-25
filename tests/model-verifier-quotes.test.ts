import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { createFreeQuoter } from '@gyblos/model-verifier/quotes';
import { CONTROL_METHODS } from '@gyblos/protocol/constants';
import type { ControlQuery } from '@gyblos/protocol/control-types';
import { parseOfferV2 } from '@gyblos/protocol/offer-v2';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';
import { PUBLIC_TEST_NOW } from './support/public-records';

async function seller() {
  const fixture = await controlFixture(true);
  let catalogs = 0;
  const exchange = async (query: ControlQuery) => {
    if (query.method === CONTROL_METHODS.CATALOG) {
      catalogs++;
      return { method: query.method, catalog: fixture.context.catalog };
    }
    if (query.method !== CONTROL_METHODS.OFFER) throw new Error('unexpected');
    return {
      method: query.method,
      offer: await createControlQuote(
        query,
        fixture.context,
        fixture.ownerSigner,
      ),
    };
  };
  const { owner, nodeId, relayAllowed } = fixture.trust();
  const quoter = createFreeQuoter(
    exchange,
    { owner, nodeId, relayAllowed },
    fixture.catalog.models[0]!.modelId,
    {
      address: fixture.request.params.buyer,
      nodeId: fixture.context.remoteNodeId,
    },
    () => PUBLIC_TEST_NOW,
  );
  return {
    fixture,
    quoter,
    catalogs: () => catalogs,
    async renew() {
      const record = fixture.context.catalog.record;
      fixture.context.catalog = await signPublicV2(
        { ...fixture.catalog, sequence: record.sequence + 1 },
        fixture.nodeSigner,
      );
    },
  };
}

void test('a free quote follows a catalog the seller renewed during the run', async () => {
  const run = await seller();
  const selection = await run.quoter.open();
  assert.equal(selection.modelId, run.fixture.catalog.models[0]!.modelId);
  const first = parseOfferV2((await run.quoter.quote(100)).offer);
  await run.renew();
  const second = parseOfferV2((await run.quoter.quote(100)).offer);
  assert.notEqual(second.catalogDigest, first.catalogDigest);
  assert.equal(run.catalogs(), 2);
});
