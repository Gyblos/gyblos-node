// Seller control over several offers: the signed catalog lists exactly the offers that are ready, a
// quote is bound to its own offer, and the catalog never signs an empty model list. Synthetic offers
// and ephemeral unfunded signers; no engines, files or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES, PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type {
  ControlResponse,
  PublicCatalogV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';

import { PUBLIC_TEST_NOW } from './support/public-records';
import { offerControlFixture } from './support/seller-offer-control';

const code = (response: ControlResponse) =>
  'error' in response ? response.error?.code : undefined;

void test('a failed offer leaves the catalog; its quotes are MODEL while the other offer still quotes', async () => {
  const run = await offerControlFixture();
  assert.deepEqual(run.listedModels(), [
    run.a.live.offer.modelId,
    run.b.live.offer.modelId,
  ]);
  run.b.set({ validUntil: 0 });
  assert.throws(() => run.records.current(), {
    code: CONTROL_CODES.STALE,
  });
  await run.records.refresh();
  assert.deepEqual(run.listedModels(), [run.a.live.offer.modelId]);
  assert.equal(code(await run.quote(run.b.live)), CONTROL_CODES.MODEL);
  const quoted = await run.quote(run.a.live);
  assert.equal(code(quoted), undefined, JSON.stringify(quoted));
});

void test('an offer that recovers is listed again under a new digest and a higher sequence', async () => {
  const run = await offerControlFixture();
  run.b.set({ validUntil: 0 });
  const without = await run.records.refresh();
  run.b.set({
    validUntil: PUBLIC_TEST_NOW + 30_000,
    observedAt: PUBLIC_TEST_NOW - 1,
  });
  const back = await run.records.refresh();
  assert.ok(back.record.sequence > without.record.sequence);
  assert.notEqual(
    await catalogDigestV2(back.record as PublicCatalogV2),
    await catalogDigestV2(without.record as PublicCatalogV2),
  );
  assert.equal(run.listedModels().length, 2);
});

void test('with every offer down the catalog is EXPIRED and no empty model list is ever signed', async () => {
  const run = await offerControlFixture();
  const before = run.records.current();
  run.a.set({ validUntil: 0 });
  run.b.set({ validUntil: 0 });
  await assert.rejects(run.records.refresh(), {
    code: CONTROL_CODES.EXPIRED,
  });
  await assert.rejects(run.records.refresh(true), {
    code: CONTROL_CODES.EXPIRED,
  });
  assert.throws(() => run.records.current());
  assert.ok(before.record.kind === PUBLIC_RECORD_KINDS.CATALOG);
});

void test('one busy offer does not make another offer’s quote BUSY', async () => {
  const run = await offerControlFixture();
  run.a.set({ busy: true });
  const quoted = await run.quote(run.b.live);
  assert.equal(code(quoted), undefined, JSON.stringify(quoted));
  assert.equal(code(await run.quote(run.a.live)), CONTROL_CODES.BUSY);
});

void test('a renewing offer is never signed into a catalog bounded by the other offers', async () => {
  const run = await offerControlFixture();
  run.a.set({ busy: true, validUntil: 0 });
  run.b.set({
    observedAt: PUBLIC_TEST_NOW - 1,
    validUntil: PUBLIC_TEST_NOW + 600_000,
  });
  const signed = await run.records.refresh();
  assert.deepEqual(
    (signed.record as PublicCatalogV2).models.map((model) => model.modelId),
    [run.b.live.offer.modelId],
  );
  // A quote for the renewing offer is refused as an unlisted model, not served.
  assert.equal(code(await run.quote(run.a.live)), CONTROL_CODES.MODEL);
});
