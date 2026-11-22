import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionRig } from './support/batch-session';
import { multisellerSession } from './support/multiseller-session';

void test('a seller refusal releases only the exact unsigned request and preserves the open channel', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const channel = rig.buyer.snapshot().channelId;
  const request = rig.request(1);
  await rig.buyer.beginBlocks(request);
  await assert.rejects(async () =>
    rig.buyer.releaseDeclined!(channel, {
      ...request,
      requestDigest: 'aa'.repeat(32),
    }),
  );
  await rig.buyer.releaseDeclined!(channel, request);
  assert.equal(rig.buyer.snapshot().reservedAtomic, '0');
  await rig.serve(2, '4');
  assert.equal(rig.buyer.snapshot().channelId, channel);
  assert.equal(rig.buyer.snapshot().cumulativeAtomic, '4');
  await assert.rejects(async () =>
    rig.buyer.releaseDeclined!(channel, rig.request(2)),
  );
});

void test('a restarted pooled buyer reconciles a persisted refusal before another request', async (t) => {
  const f = await multisellerSession();
  t.after(f.close);
  let pool = await f.options.pool();
  t.after(() => pool.dispose());
  const { terms } = f.a;
  await pool.allocate(terms);
  const request = f.a.request(1);
  await pool.begin(terms.sellerNodeId, request.requestId);
  const backend = await pool.backend(terms.sellerNodeId);
  const buyer = await backend.create(terms);
  await buyer.open();
  await buyer.begin(request);
  await buyer.releaseDeclined!(buyer.snapshot().channelId, request);
  await buyer.dispose();
  await pool.dispose();
  pool = await f.options.pool();
  assert.equal(await pool.resolve(terms.sellerNodeId), true);
  const next = f.a.request(2).requestId;
  await pool.begin(terms.sellerNodeId, next);
  assert.equal(await pool.resolve(terms.sellerNodeId, next), true);
});
