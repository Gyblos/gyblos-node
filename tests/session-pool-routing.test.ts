// Sequential selected-seller routing restores original private sessions without inference retry or new deposits.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { inspectBatchPool } from '@gyblos/payments-upto/batch-session';

import { batchLoopback } from './support/batch-loopback';
import { multisellerSession } from './support/multiseller-session';

void test('shared manager routes A to B to A across restart with two deposits and the original A channel', async (t) => {
  const fixture = await multisellerSession();
  const { a, b, rigs, offers, paths } = fixture;
  const wires = await Promise.all(
    rigs.map((rig, index) =>
      batchLoopback(
        createSellerBatchSession({
          session: rig.seller(),
          terms: rig.terms,
          offers: () => [offers[index]!.live],
          now: rig.now,
        }),
        rig.terms,
      ),
    ),
  );
  const endpoint = {
    id: wires[0]!.endpoint.id,
    connect: (
      destination: (typeof wires)[0]['destination'],
      alpn: Parameters<(typeof wires)[0]['endpoint']['connect']>[1],
    ) =>
      wires[
        destination.id().toString() === a.terms.sellerNodeId ? 0 : 1
      ]!.endpoint.connect(destination, alpn),
  };
  const options = {
    ...fixture.options,
    endpoint,
    destination: (terms: typeof a.terms) =>
      wires[terms.sellerNodeId === a.terms.sellerNodeId ? 0 : 1]!.destination,
  };
  let buyer = createBuyerSessionPool(options);
  t.after(async () => {
    await buyer.close();
    for (const w of wires) await w.close();
    for (const r of rigs) await r.dispose();
  });
  await buyer.execute(
    await offers[0]!.quote(1),
    offers[0]!.input,
    new AbortController().signal,
  );
  const original = (await inspectBatchPool(paths))[0]!.stored!.snapshot
    .channelId;
  await buyer.execute(
    await offers[1]!.quote(2),
    offers[1]!.input,
    new AbortController().signal,
  );
  await buyer.close();
  buyer = createBuyerSessionPool(options);
  await buyer.execute(
    await offers[0]!.quote(3),
    offers[0]!.input,
    new AbortController().signal,
  );
  const entries = await inspectBatchPool(paths);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.stored!.snapshot.channelId, original);
  assert.equal(entries[0]!.stored!.snapshot.cumulativeAtomic, '80');
  assert.equal(entries[1]!.stored!.snapshot.cumulativeAtomic, '40');
  assert.deepEqual(a.calls, ['deposit']);
  assert.deepEqual(b.calls, ['deposit']);
  assert.equal(offers[0]!.generations(), 2);
  assert.equal(offers[1]!.generations(), 1);
  assert.deepEqual(await buyer.settle(new AbortController().signal), {
    chargedAtomic: '120',
    refundedAtomic: '1880',
  });
  await buyer.close();
  const recovered = await options.pool();
  assert.deepEqual(await recovered.budget(), {
    committedAtomic: '120',
    availableAtomic: '1880',
  });
  await recovered.dispose();
  const repeated = await options.pool();
  assert.deepEqual(await repeated.budget(), {
    committedAtomic: '120',
    availableAtomic: '1880',
  });
  await repeated.dispose();
});
