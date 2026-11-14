// Real SDK vouchers and private journals; every financial operation uses synthetic local services.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createBatchBuyer,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';
import { blockJson } from './support/block-json';
import { blockIntent as intent } from './support/session-block-intent';

void test('three blocks retain one inference reservation and one deposit until terminal ACK', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  for (let index = 0; index < 3; index++) {
    const current = intent(
      request,
      index,
      String((index + 1) * 10),
      index === 2,
    );
    await f.seller().checkpoint(current);
    const voucher = await f.buyer.approveBlock(
      current,
      current.bill.chargedAtomic,
    );
    assert.equal(
      f.buyer.snapshot().reservedAtomic,
      String(200 - (index + 1) * 10),
    );
    await f.seller().acceptBlock(current, voucher, f.terms.buyerNodeId);
    assert.equal(
      f.seller().snapshot().reservedAtomic,
      index === 2 ? '0' : String(200 - (index + 1) * 10),
    );
    await f.buyer.acknowledgeBlock(current);
  }
  assert.equal(f.buyer.snapshot().reservedAtomic, '0');
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '30');
  assert.deepEqual(f.calls, ['deposit']);
  const closed = await f.seller().close();
  assert.equal(closed.chargedAtomic, '30');
  assert.equal(closed.refundedAtomic, '970');
});
void test('an intermediate ACK cannot admit another inference in the same channel', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');
  await f.seller().checkpoint(first);
  const voucher = await f.buyer.approveBlock(first, '10');
  await f.seller().acceptBlock(first, voucher, f.terms.buyerNodeId);
  await f.buyer.acknowledgeBlock(first);
  const busy = (error: unknown) =>
    error instanceof PaymentSessionError && error.code === SESSION_CODES.BUSY;
  await assert.rejects(f.buyer.beginBlocks(f.request(2)), busy);
  await assert.rejects(
    f.seller().reserveBlocks(f.request(2), f.terms.buyerNodeId),
    busy,
  );
});
void test('seller release never clears a partial signed total and permits idle finalization', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');
  await f.seller().checkpoint(first);
  const voucher = await f.buyer.approveBlock(first, '10');
  await f.seller().acceptBlock(first, voucher, f.terms.buyerNodeId);
  await f.buyer.acknowledgeBlock(first);
  await f.seller().releaseBlocks(request.requestId);
  f.time(f.now() + 1001);
  const closed = await f.seller().tick();
  assert.equal(closed?.chargedAtomic, '10');
  assert.equal(closed?.refundedAtomic, '990');
});
void test('reopening a block journal returns the exact original opening without another deposit', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const opening = await f.buyer.open();
  await f.buyer.beginBlocks(f.request(1));
  await f.buyer.dispose();
  const buyer = await createBatchBuyer(f.buyerOptions);
  t.after(buyer.dispose);
  assert.equal(await buyer.open(), opening);
  assert.deepEqual(f.calls, ['deposit']);
});

void test('a crash after durable intent recovers only the exact verified block after buyer restart', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');
  await f.seller().checkpoint(first);
  let checks = 0;
  await assert.rejects(
    f.buyer.approveBlock(first, '10', () => {
      if (++checks === 2)
        throw new Error('synthetic interruption before signing');
    }),
  );
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '0');
  assert.equal(f.buyer.snapshot().reservedAtomic, '200');
  await f.buyer.dispose();
  const buyer = await createBatchBuyer(f.buyerOptions);
  t.after(buyer.dispose);
  const recovered = await buyer.recoverBlockApproval();
  assert.ok(recovered);
  assert.deepEqual(recovered.intent, first);
  await f.seller().acceptBlock(first, recovered.voucher, f.terms.buyerNodeId);
  await buyer.acknowledgeBlock(first);
  assert.equal(buyer.snapshot().cumulativeAtomic, '10');
  assert.equal(buyer.snapshot().reservedAtomic, '190');
  assert.deepEqual(f.calls, ['deposit']);
});

void test('a lost final ACK is idempotent after seller restart and cannot duplicate the charge', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const last = intent(request, 0, '10', true);
  await f.seller().checkpoint(last);
  const voucher = await f.buyer.approveBlock(last, '10');
  await f.seller().acceptBlock(last, voucher, f.terms.buyerNodeId);
  await f.restart();
  const recovered = await f.buyer.recoverBlockApproval();
  assert.deepEqual(recovered, { intent: last, voucher });
  await f.seller().acceptBlock(last, voucher, f.terms.buyerNodeId);
  await f.buyer.acknowledgeBlock(last);
  assert.equal(f.seller().snapshot().cumulativeAtomic, '10');
  assert.equal(f.buyer.snapshot().reservedAtomic, '0');
  assert.equal(await f.buyer.recoverBlockApproval(), undefined);
});

void test('private progress stores only rolling metadata and preserves pending recovery and modes', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');
  await f.seller().checkpoint(first);
  await f.buyer.approveBlock(first, '10');
  const text = await readFile(f.buyerOptions.paths.state, 'utf8');
  const record = blockJson(JSON.parse(text));
  assert.equal(record.version, 2);
  assert.equal(Object.keys(blockJson(record.requests)).length, 1);
  assert.equal(
    blockJson(blockJson(record.requests)[request.requestId]).bill,
    null,
  );
  assert.equal(
    blockJson(blockJson(record.requests)[request.requestId]).accepted,
    false,
  );
  assert.deepEqual(
    Object.keys(blockJson(blockJson(record.blocks)[request.requestId])).sort(),
    ['accepted', 'baseAtomic', 'pending'],
  );
  assert.ok(
    !text.includes('"text"') &&
      !text.includes('"messages"') &&
      !text.includes('"toolCalls"'),
  );
  assert.equal((await stat(f.buyerOptions.paths.state)).mode & 0o777, 0o600);
  const stored = await inspectBatchSession(f.buyerOptions.paths);
  assert.equal(stored?.pending, true);
  assert.equal(stored?.recoverable, true);
});

void test('restart leaves no runtime generation owner and settles the highest partial voucher', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  const first = intent(request, 0, '10');
  await f.seller().checkpoint(first);
  const voucher = await f.buyer.approveBlock(first, '10');
  await f.seller().acceptBlock(first, voucher, f.terms.buyerNodeId);
  f.time(f.now() + 1001);
  assert.equal(await f.seller().tick(), undefined);
  await f.restart();
  const closed = await f.seller().tick();
  assert.equal(closed?.chargedAtomic, '10');
  assert.equal(closed?.refundedAtomic, '990');
});
