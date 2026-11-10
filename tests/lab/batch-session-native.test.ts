// Product batch sessions execute the pinned SDK and official source-built program in LiteSVM.
// Synthetic mint and keys only; this is not deployed-program equivalence or an operational payment.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { address, getTransactionDecoder } from '@solana/kit';
import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';
import {
  createUptoChannelReaders,
  requestCloseInstruction,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_PROGRAM,
} from 'x402-upto-metered';

import { PROTOCOL_FEE } from '@gyblos/config';
import { batchSessionPathsIn } from '@gyblos/config/home';
import {
  batchFacilitatorFor,
  createBatchBuyer,
  createBatchSeller,
  type BatchSellerOptions,
} from '@gyblos/payments-upto/batch-session';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import type {
  PaymentSessionTerms,
  SessionSettlement,
} from '@gyblos/protocol/payment-session';

import { nativeVm } from '../support/paid-native-vm';

for (const scenario of [
  'idle',
  'forced-close',
  'lost-confirmation',
  'lost-opening',
] as const)
  void test(`batch native: one deposit and post-usage vouchers survive ${scenario} and seller restart`, async (t) => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2);
    const root = await mkdtemp(join(tmpdir(), 'gyb-batch-native-'));
    const terms: PaymentSessionTerms = {
      buyer: vm.payer.address,
      buyerNodeId: '12'.repeat(32),
      owner: vm.seller.address,
      sellerNodeId: '34'.repeat(32),
      network: vm.network,
      mint: vm.mint.address,
      payTo: vm.seller.address,
      feePayer: vm.feePayer.address,
      authorizer: vm.authorizer.address,
      treasury: vm.fee.address,
      protocolFeeBps: PROTOCOL_FEE.bps,
      depositAtomic: '1000',
      withdrawDelaySeconds: 900,
      expiresAt: now + 3_600_000,
    };
    let forcedClose = false;
    let loseOpening = scenario === 'lost-opening';
    const before = await vm.balance(vm.payer.address);
    const confirm = async (result: SessionSettlement) => {
      const shares = settlementShares(result.chargedAtomic, PROTOCOL_FEE.bps);
      return (
        vm.signatureSucceeded(result.transaction) &&
        (await vm.balance(vm.payer.address)) ===
          before - BigInt(result.chargedAtomic) &&
        (await vm.balance(vm.seller.address)) === BigInt(shares.sellerAtomic) &&
        (await vm.balance(vm.fee.address)) === BigInt(shares.feeAtomic)
      );
    };
    const readers = createUptoChannelReaders(
      {
        getAccountInfo: async (id) => {
          const account = await vm.accountInfo(address(id), vm.network);
          if (!account) return null;
          if (
            !Array.isArray(account.data) ||
            typeof account.data[0] !== 'string'
          )
            throw new Error('synthetic account shape');
          const data: [string, 'base64'] = [account.data[0], 'base64'];
          return { owner: account.owner, data };
        },
        signaturesSucceeded: async (signatures) =>
          signatures.map(vm.signatureSucceeded),
      },
      { network: vm.network, rentPayer: vm.feePayer.address },
    );
    const observe = async (
      channelId: string,
    ): Promise<SessionSettlement | undefined> => {
      const channel = await readers.channelState(channelId);
      if (channel?.status !== UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED)
        return undefined;
      const transaction = vm.history
        .signatures(channelId)
        .find((entry) => vm.signatureSucceeded(entry.signature));
      if (!transaction) return undefined;
      const settled = {
        channelId,
        chargedAtomic: channel.settledAtomic,
        refundedAtomic: String(1000n - BigInt(channel.settledAtomic)),
        transaction: transaction.signature,
      };
      return (await confirm(settled)) ? settled : undefined;
    };
    const buyer = await createBatchBuyer({
      terms,
      payer: vm.payer,
      paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer'),
      now: () => now,
      hints: async () => ({
        blockhash: vm.hints().recentBlockhash,
        lastValidBlockHeight: vm.hints().lastValidBlockHeight,
        slot: vm.hints().recentSlot,
      }),
    });
    const options: BatchSellerOptions = {
      terms,
      authorizer: vm.authorizer,
      paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller'),
      now: () => now,
      facilitator: async (
        ...args: Parameters<ReturnType<typeof batchFacilitatorFor>>
      ) => {
        const sdk = await batchFacilitatorFor(vm.signer, terms)(...args);
        return {
          verify: sdk.verify.bind(sdk),
          settle: async (...call: Parameters<typeof sdk.settle>) => {
            const result = await sdk.settle(...call);
            if (
              call[0].payload.type === 'deposit' &&
              result.success &&
              loseOpening
            ) {
              loseOpening = false;
              throw new Error('synthetic opening response lost');
            }
            assert.ok(
              result.success,
              result.errorReason ?? 'synthetic SDK failure',
            );
            return result;
          },
        };
      },
      observe,
      closing: async () => forcedClose,
      observeOpening: async (opening) => {
        const channel = await readers.channelState(opening.voucher!.channelId);
        if (
          channel?.status !== UPTO_CHANNEL_ACCOUNT.statuses.OPEN ||
          channel.depositAtomic !== terms.depositAtomic
        )
          return false;
        const message = getTransactionDecoder().decode(
          Buffer.from(opening.deposit.transaction, 'base64'),
        ).messageBytes;
        return vm.history
          .signatures(opening.voucher!.channelId)
          .some(
            (entry) =>
              vm.signatureSucceeded(entry.signature) &&
              vm.history.message(entry.signature)?.equals(Buffer.from(message)),
          );
      },
      minSettlementAtomic: '100',
      idleMs: 1000,
    };
    let seller = await createBatchSeller(options);
    t.after(async () => {
      await buyer.dispose();
      await seller.dispose();
    });
    const beforeOpen = vm.sends();
    if (scenario === 'lost-opening') {
      await assert.rejects(seller.open(await buyer.open()));
      await seller.dispose();
      seller = await createBatchSeller(options);
    }
    await seller.open(await buyer.open());
    assert.equal(await vm.balance(vm.payer.address), before - 1000n);
    assert.equal(await vm.balance(vm.seller.address), 0n);
    assert.equal(vm.sends(), beforeOpen + 1);
    let cumulative = 0;
    for (const [index, charge] of [40, 60, 45].entries()) {
      const request = {
        requestId: (index + 1).toString(16).padStart(32, '0'),
        requestDigest: (index + 1).toString(16).padStart(64, '0'),
        maxAtomic: '200',
      };
      await buyer.begin(request);
      await seller.reserve(request, terms.buyerNodeId);
      const bill = await seller.finish(request.requestId, String(charge));
      const voucher = await buyer.approve(bill, String(charge));
      await seller.accept(bill, voucher, terms.buyerNodeId);
      await buyer.acknowledge(request.requestId);
      cumulative += charge;
      assert.equal(bill.cumulativeAtomic, String(cumulative));
      assert.equal(vm.sends(), beforeOpen + 1);
    }
    if (scenario === 'forced-close') {
      await vm.send([
        requestCloseInstruction(vm.payer, buyer.snapshot().channelId),
      ]);
      forcedClose = true;
    }
    if (scenario === 'lost-confirmation') {
      vm.loseConfirmation(true);
      await assert.rejects(seller.close());
      vm.loseConfirmation(false);
      now += 180_000;
      vm.time(Math.floor(now / 1000));
    }
    await seller.dispose();
    seller = await createBatchSeller(options);
    now += 1001;
    vm.time(Math.floor(now / 1000));
    const closed = await seller.tick();
    assert.ok(closed);
    assert.equal(closed.chargedAtomic, '145');
    assert.equal(closed.refundedAtomic, '855');
    assert.equal(await confirm(closed), true);
    const residual = await vm.balance(UPTO_PROGRAM.treasuryOwners.mainnet);
    assert.equal(
      (await vm.balance(vm.seller.address)) +
        (await vm.balance(vm.fee.address)) +
        residual,
      145n,
    );
    const sends = vm.sends();
    assert.deepEqual(await seller.close(), closed);
    assert.equal(vm.sends(), sends);
  });
