// Financial recovery repeats a stored approval only, including when the next unsigned block already exists.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SESSION_CODES,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';
import {
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  type SessionBlockApproval,
  type SessionBlockIntent,
} from '@gyblos/protocol/session-blocks';

import { sessionRig } from './support/batch-session';
import { blockIntent } from './support/session-block-intent';

function approval(
  channelId: string,
  intent: SessionBlockIntent,
  voucher: SessionVoucher,
): SessionBlockApproval {
  return {
    version: SESSION_BLOCKS.version,
    kind: SESSION_BLOCK_KINDS.APPROVAL,
    channelId,
    requestId: intent.bill.requestId,
    requestDigest: intent.bill.requestDigest,
    index: intent.index,
    blockDigest: intent.digest,
    voucher,
  };
}
void test('recovery locates the exact pending approval after restart without another request or deposit', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const intent = blockIntent(request, 0, '10');
  await f.seller().checkpoint(intent);
  const voucher = await f.buyer.approveBlock(intent, '10');
  await f.restart();
  assert.deepEqual(f.buyer.pendingBlockRequest(), request);
  assert.deepEqual(
    await f
      .seller()
      .resumeBlock(
        approval(f.buyer.snapshot().channelId, intent, voucher),
        f.terms.buyerNodeId,
      ),
    intent,
  );
  assert.equal(f.seller().snapshot().cumulativeAtomic, '10');
  assert.deepEqual(f.calls, ['deposit']);
});
void test('recovery of an accepted block preserves the next unsigned checkpoint and cannot double bill', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = blockIntent(request, 0, '10');
  await f.seller().checkpoint(first);
  const voucher = await f.buyer.approveBlock(first, '10');
  await f.seller().acceptBlock(first, voucher, f.terms.buyerNodeId);
  const next = blockIntent(request, 1, '20');
  await f.seller().checkpoint(next);
  assert.deepEqual(
    await f
      .seller()
      .resumeBlock(
        approval(f.buyer.snapshot().channelId, first, voucher),
        f.terms.buyerNodeId,
      ),
    first,
  );
  await f.buyer.acknowledgeBlock(first);
  const nextVoucher = await f.buyer.approveBlock(next, '20');
  await f.seller().acceptBlock(next, nextVoucher, f.terms.buyerNodeId);
  assert.equal(f.seller().snapshot().cumulativeAtomic, '20');
});
void test('recovery rejects the wrong peer, digest or request without accepting a financial total', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const intent = blockIntent(request, 0, '10');
  await f.seller().checkpoint(intent);
  const voucher = await f.buyer.approveBlock(intent, '10');
  const row = approval(f.buyer.snapshot().channelId, intent, voucher);
  for (const [value, peer] of [
    [row, 'ff'.repeat(32)],
    [{ ...row, blockDigest: 'ff'.repeat(32) }, f.terms.buyerNodeId],
    [{ ...row, requestId: 'ff'.repeat(16) }, f.terms.buyerNodeId],
  ] as const)
    await assert.rejects(f.seller().resumeBlock(value, peer), {
      code: SESSION_CODES.BINDING,
    });
  assert.equal(f.seller().snapshot().cumulativeAtomic, '0');
});
