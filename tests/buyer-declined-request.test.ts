import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionRig } from './support/batch-session';

void test('a seller refusal releases only the exact unsigned request and preserves the open channel', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const channel = rig.buyer.snapshot().channelId;
  const request = rig.request(1);
  await rig.buyer.beginBlocks(request);
  await assert.rejects(async () => rig.buyer.releaseDeclined!(channel, {...request, requestDigest:'aa'.repeat(32)}));
  await rig.buyer.releaseDeclined!(channel, request);
  assert.equal(rig.buyer.snapshot().reservedAtomic, '0');
  await rig.serve(2,'4');
  assert.equal(rig.buyer.snapshot().channelId, channel);
  assert.equal(rig.buyer.snapshot().cumulativeAtomic, '4');
  await assert.rejects(async () => rig.buyer.releaseDeclined!(channel, rig.request(2)));
});
