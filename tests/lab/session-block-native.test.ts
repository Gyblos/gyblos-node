// Current SDK and pinned payment-channel program in LiteSVM: signatures per block, transactions only at open/close.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UPTO_PROGRAM } from 'x402-upto-metered';

import { PROTOCOL_FEE } from '@gyblos/config';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { batchNativeFinancial } from '../support/batch-native';
import { blockIntent } from '../support/session-block-intent';

for (const scenario of ['complete', 'last-approval-lost', 'seller-restart']) {
  void test(`native block vouchers share one deposit and conserve split/refund after ${scenario}`, async (t) => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const f = await batchNativeFinancial(() => now, {
      buyerNodeId: '12'.repeat(32),
      sellerNodeId: '34'.repeat(32),
    });
    t.after(f.dispose);
    const request = {
      requestId: '11'.repeat(16),
      requestDigest: '22'.repeat(32),
      maxAtomic: '100',
    };
    const programTreasuryBefore = await f.vm.balance(
      UPTO_PROGRAM.treasuryOwners.mainnet,
    );
    const beforeSends = f.vm.sends();
    await f.seller().open(await f.buyer.open());
    assert.equal(f.vm.sends(), beforeSends + 1);
    await f.buyer.beginBlocks(request);
    await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
    for (let index = 0; index < 3; index++) {
      const intent = blockIntent(
        request,
        index,
        String((index + 1) * 10),
        index === 2,
      );
      await f.seller().checkpoint(intent);
      const voucher = await f.buyer.approveBlock(
        intent,
        intent.bill.chargedAtomic,
      );
      if (index === 2 && scenario !== 'complete') break;
      await f.seller().acceptBlock(intent, voucher, f.terms.buyerNodeId);
      await f.buyer.acknowledgeBlock(intent);
      assert.equal(f.vm.sends(), beforeSends + 1, 'No per-block transaction');
    }
    assert.equal(f.vm.sends(), beforeSends + 1);
    if (scenario === 'seller-restart') {
      await f.restart();
      await assert.rejects(
        f.seller().checkpoint(blockIntent(request, 2, '30', true)),
        (error: unknown) =>
          error instanceof PaymentSessionError &&
          error.code === SESSION_CODES.BINDING,
      );
    }
    await f.seller().releaseBlocks(request.requestId);
    now += 1001;
    const settled =
      scenario === 'complete'
        ? await f.seller().close()
        : await f.seller().tick();
    assert.ok(settled);
    const charged = scenario === 'complete' ? '30' : '20';
    assert.equal(settled.chargedAtomic, charged);
    assert.equal(settled.refundedAtomic, String(1000 - Number(charged)));
    const shares = settlementShares(charged, PROTOCOL_FEE.bps);
    assert.equal(
      await f.vm.balance(f.vm.payer.address),
      f.before.buyer - BigInt(charged),
    );
    assert.equal(
      await f.vm.balance(f.vm.seller.address),
      f.before.seller + BigInt(shares.sellerAtomic),
    );
    assert.equal(
      await f.vm.balance(f.vm.fee.address),
      f.before.treasury + BigInt(shares.feeAtomic),
    );
    const residual =
      BigInt(charged) - BigInt(shares.sellerAtomic) - BigInt(shares.feeAtomic);
    assert.equal(
      await f.vm.balance(UPTO_PROGRAM.treasuryOwners.mainnet),
      programTreasuryBefore + residual,
    );
    assert.deepEqual(await f.buyer.reconcile(f.observe), settled);
  });
}
