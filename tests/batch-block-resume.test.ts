// The separate recovery stream carries the exact stored voucher, never an inference input or prompt.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_BLOCKS, SESSION_BLOCK_KINDS, type SessionBlockApproval } from '@gyblos/protocol/session-blocks';
import { createBatchChannelClient } from '@gyblos/transport-iroh/batch-client';

import { sessionRig } from './support/batch-session';
import { blockIntent } from './support/session-block-intent';
import { batchLoopback } from './support/batch-loopback';

void test('a fresh connection recovers the same stored block approval twice without sending an execution', async (t) => {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const request = f.request(1);await f.buyer.beginBlocks(request);await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const intent = blockIntent(request, 0, '10');await f.seller().checkpoint(intent);
  const voucher = await f.buyer.approveBlock(intent, '10');
  let executions = 0;
  const wire = await batchLoopback({ async exchange() { executions++;throw new Error('Forbidden synthetic execution'); }, async resumeBlock(row, peer) { const restored = await f.seller().resumeBlock(row, peer);return { version: row.version, channelId: row.channelId, requestId: row.requestId, requestDigest: row.requestDigest, index: row.index, kind: SESSION_BLOCK_KINDS.ACK, blockDigest: restored.digest, cumulativeAtomic: restored.bill.cumulativeAtomic }; } }, f.terms, true);t.after(wire.close);
  const client = createBatchChannelClient(wire.endpoint, wire.destination, f.terms.sellerNodeId, { blocks: true });t.after(async () => { await client.close();await client.settled(); });
  const row: SessionBlockApproval = { version: SESSION_BLOCKS.version, kind: SESSION_BLOCK_KINDS.APPROVAL, channelId: f.buyer.snapshot().channelId, requestId: request.requestId, requestDigest: request.requestDigest, index: intent.index, blockDigest: intent.digest, voucher };
  for (let index = 0; index < 2; index++) {
    const ack = await client.resumeBlock(row);assert.equal(ack.kind, SESSION_BLOCK_KINDS.ACK);assert.equal(ack.cumulativeAtomic, '10');
  }
  assert.equal(executions, 0);assert.deepEqual(f.calls, ['deposit']);
});
