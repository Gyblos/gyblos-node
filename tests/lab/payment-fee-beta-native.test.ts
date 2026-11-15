// The current SDK and pinned source-built program settle synthetic charges in LiteSVM.
// The offline fixture's network label selects its treasury; deployed-program equivalence is unverified.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';

import { UPTO_PROGRAM } from 'x402-upto-metered';

import { PROTOCOL_FEE } from '@gyblos/config';

import { batchNativeFinancial } from '../support/batch-native';

for (const [charged, seller, gyblos, residual, refunded] of [
  ['26', '25', '0', '1', '974'],
  ['625', '601', '24', '0', '375'],
] as const) {
  void test(`native beta collection of ${charged} atoms conserves seller, Gyblos, residual and refund`, async (t) => {
    const now = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const financial = await batchNativeFinancial(() => now, {
      buyerNodeId: '12'.repeat(32),
      sellerNodeId: '34'.repeat(32),
    });
    t.after(async () => {
      await financial.dispose();
      await rm(financial.root, { recursive: true, force: true });
    });
    assert.equal(financial.terms.protocolFeeBps, PROTOCOL_FEE.bps);
    const programTreasury = UPTO_PROGRAM.treasuryOwners.mainnet;
    const beforeProgram = await financial.vm.balance(programTreasury);
    await financial.seller().open(await financial.buyer.open());
    const afterDeposit = await financial.vm.balance(financial.vm.payer.address);
    assert.equal(afterDeposit, financial.before.buyer - 1000n);
    const request = {
      requestId: '11'.repeat(16),
      requestDigest: '22'.repeat(32),
      maxAtomic: charged,
    };
    await financial.buyer.begin(request);
    await financial.seller().reserve(request, financial.terms.buyerNodeId);
    const bill = await financial.seller().finish(request.requestId, charged);
    const voucher = await financial.buyer.approve(bill, charged);
    await financial.seller().accept(bill, voucher, financial.terms.buyerNodeId);
    await financial.buyer.acknowledge(request.requestId);
    const settled = await financial.seller().close();
    assert.ok(settled);
    assert.equal(settled.chargedAtomic, charged);
    assert.equal(settled.refundedAtomic, refunded);
    assert.equal(financial.vm.signatureSucceeded(settled.transaction), true);
    const sellerReceived =
      (await financial.vm.balance(financial.vm.seller.address)) -
      financial.before.seller;
    const gyblosReceived =
      (await financial.vm.balance(financial.vm.fee.address)) -
      financial.before.treasury;
    const programReceived =
      (await financial.vm.balance(programTreasury)) - beforeProgram;
    const buyerAfter = await financial.vm.balance(financial.vm.payer.address);
    assert.equal(sellerReceived, BigInt(seller));
    assert.equal(gyblosReceived, BigInt(gyblos));
    assert.equal(programReceived, BigInt(residual));
    assert.equal(buyerAfter - afterDeposit, BigInt(refunded));
    assert.equal(financial.before.buyer - buyerAfter, BigInt(charged));
    assert.equal(
      sellerReceived + gyblosReceived + programReceived,
      BigInt(charged),
    );
    assert.equal(
      sellerReceived + gyblosReceived + programReceived + BigInt(refunded),
      1000n,
    );
    assert.equal(await financial.vm.balance(settled.channelId), 0n);
    assert.deepEqual(
      await financial.buyer.reconcile(financial.observe),
      settled,
    );
  });
}
