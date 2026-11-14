// Real SDK vouchers and private journals; every financial operation uses synthetic local services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_CODES, PaymentSessionError } from '@gyblos/protocol/payment-session';
import type { SessionBlockIntent } from '@gyblos/protocol/session-blocks';

import { sessionRig } from './support/batch-session';

function intent(request: { requestId: string; requestDigest: string; maxAtomic: string }, index: number, amount: string, terminal = false): SessionBlockIntent {
  return { index, digest: (index + 1).toString(16).padStart(64, '0'), usage: { inputTokens: 2, outputTokens: index + 1 }, bill: { ...request, chargedAtomic: amount, cumulativeAtomic: amount }, terminal };
}
void test('three blocks retain one inference reservation and one deposit until terminal ACK', async (t) => {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  for (let index = 0; index < 3; index++) {
    const current = intent(request, index, String((index + 1) * 10), index === 2);
    await f.seller().checkpoint(current);
    const voucher = await f.buyer.approveBlock(current, current.bill.chargedAtomic);
    assert.equal(f.buyer.snapshot().reservedAtomic, String(200 - (index + 1) * 10));
    await f.seller().acceptBlock(current, voucher, f.terms.buyerNodeId);
    assert.equal(f.seller().snapshot().reservedAtomic, index === 2 ? '0' : String(200 - (index + 1) * 10));
    await f.buyer.acknowledgeBlock(current);
  }
  assert.equal(f.buyer.snapshot().reservedAtomic, '0');
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '30');
  assert.deepEqual(f.calls, ['deposit']);
  const closed = await f.seller().close();
  assert.equal(closed.chargedAtomic, '30');assert.equal(closed.refundedAtomic, '970');
});
void test('an intermediate ACK cannot admit another inference in the same channel', async (t) => {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const request = f.request(1);await f.buyer.beginBlocks(request);await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');await f.seller().checkpoint(first);
  const voucher = await f.buyer.approveBlock(first, '10');await f.seller().acceptBlock(first, voucher, f.terms.buyerNodeId);await f.buyer.acknowledgeBlock(first);
  const busy = (error: unknown) => error instanceof PaymentSessionError && error.code === SESSION_CODES.BUSY;
  await assert.rejects(f.buyer.beginBlocks(f.request(2)), busy);
  await assert.rejects(f.seller().reserveBlocks(f.request(2), f.terms.buyerNodeId), busy);
});
void test('seller release never clears a partial signed total and permits idle finalization', async (t) => {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const request = f.request(1);await f.buyer.beginBlocks(request);await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');await f.seller().checkpoint(first);
  const voucher = await f.buyer.approveBlock(first, '10');await f.seller().acceptBlock(first, voucher, f.terms.buyerNodeId);await f.buyer.acknowledgeBlock(first);
  await f.seller().releaseBlocks(request.requestId);
  f.time(f.now() + 1001);
  const closed = await f.seller().tick();assert.equal(closed?.chargedAtomic, '10');assert.equal(closed?.refundedAtomic, '990');
});
