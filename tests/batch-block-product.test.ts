// Real product quote checks, generation pipeline and financial adapters use duplex approvals on one inference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { BLOCK_TEXT, blockProduct } from './support/batch-block-product';
import { blockJson } from './support/block-json';

void test('product buyer and seller verify each block through the shared generation pipeline', async (t) => {
  const f = await blockProduct();t.after(f.close);
  const chunks: string[] = [];
  const value = await f.buyer.execute(await f.offers.quote(1), f.offers.input, undefined, async (text) => { chunks.push(text); });
  assert.equal(value.text, BLOCK_TEXT);assert.deepEqual(chunks, ['aa ', 'bb ', 'cc']);
  assert.equal(f.offers.generations(), 1);assert.deepEqual(f.f.calls, ['deposit']);
  const raw = blockJson(JSON.parse(await readFile(f.f.buyerOptions.paths.state, 'utf8')));
  assert.equal(raw.version, 2);
  const requests = blockJson(raw.requests);assert.equal(Object.keys(requests).length, 1);
  const request = blockJson(Object.values(requests)[0]);assert.equal(request.accepted, true);
  assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '80');
});
void test('a second product inference reuses the same deposit and adds its exact cumulative cost', async (t) => {
  const f = await blockProduct();t.after(f.close);
  for (const index of [1, 2]) await f.buyer.execute(await f.offers.quote(index), f.offers.input);
  assert.equal(f.offers.generations(), 2);assert.deepEqual(f.f.calls, ['deposit']);
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '160');
  const closed = await f.buyer.close();assert.equal(closed.chargedAtomic, '160');assert.equal(closed.refundedAtomic, '840');
});
void test('cancelling after a block ACK recovers that attempt and closes only its signed prefix without replay', async (t) => {
  const f = await blockProduct();t.after(f.close);
  const controller = new AbortController();let delivered = 0;
  await assert.rejects(f.buyer.execute(await f.offers.quote(1), f.offers.input, controller.signal, async () => { delivered++;controller.abort(); }));
  await f.buyer.settled();await f.wire.settled();
  assert.equal(delivered, 1);assert.equal(f.offers.generations(), 1);
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '32');assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');
  const closed = await f.buyer.reconcile();assert.equal(closed?.chargedAtomic, '32');assert.equal(closed?.refundedAtomic, '968');
  assert.equal(f.offers.generations(), 1);assert.deepEqual(f.f.calls, ['deposit', 'refund']);
});
