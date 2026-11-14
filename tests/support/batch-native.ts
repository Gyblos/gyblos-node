// Real SDK/source-built channel program in a private VM for Iroh acceptance; synthetic keys only.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { address, getTransactionDecoder } from '@solana/kit';
import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';
import {
  createUptoChannelReaders,
  UPTO_CHANNEL_ACCOUNT,
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

import { nativeVm } from './paid-native-vm';

export async function batchNativeFinancial(
  now: () => number,
  nodes: { buyerNodeId: string; sellerNodeId: string },
  supplied: {
    network?: Parameters<typeof nativeVm>[1];
    signers?: Parameters<typeof nativeVm>[2];
    home?: string;
  } = {},
) {
  const vm = await nativeVm(
    now,
    supplied.network ?? SOLANA_TESTNET_CAIP2,
    supplied.signers,
  );
  const root =
    supplied.home ?? (await mkdtemp(join(tmpdir(), 'gyb-batch-iroh-native-')));
  const terms: PaymentSessionTerms = {
    ...nodes,
    buyer: vm.payer.address,
    owner: vm.seller.address,
    network: vm.network,
    mint: vm.mint.address,
    payTo: vm.seller.address,
    feePayer: vm.feePayer.address,
    authorizer: vm.authorizer.address,
    treasury: vm.fee.address,
    protocolFeeBps: PROTOCOL_FEE.bps,
    depositAtomic: '1000',
    withdrawDelaySeconds: 900,
    expiresAt: now() + 3600000,
  };
  const before = {
    buyer: await vm.balance(vm.payer.address),
    seller: await vm.balance(vm.seller.address),
    treasury: await vm.balance(vm.fee.address),
  };
  const readers = createUptoChannelReaders(
    {
      getAccountInfo: async (id) => {
        const account = await vm.accountInfo(address(id), vm.network);
        if (!account) return null;
        if (!Array.isArray(account.data) || typeof account.data[0] !== 'string')
          throw new Error('Synthetic account shape');
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
    const shares = settlementShares(
      channel.settledAtomic,
      terms.protocolFeeBps,
    );
    if (
      (await vm.balance(vm.payer.address)) !==
        before.buyer - BigInt(channel.settledAtomic) ||
      (await vm.balance(vm.seller.address)) !==
        before.seller + BigInt(shares.sellerAtomic) ||
      (await vm.balance(vm.fee.address)) !==
        before.treasury + BigInt(shares.feeAtomic)
    )
      return undefined;
    return {
      channelId,
      chargedAtomic: channel.settledAtomic,
      refundedAtomic: String(
        BigInt(terms.depositAtomic) - BigInt(channel.settledAtomic),
      ),
      transaction: transaction.signature,
    };
  };
  const buyerOptions = {
    terms,
    payer: vm.payer,
    now,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer'),
    hints: async () => ({
      blockhash: vm.hints().recentBlockhash,
      lastValidBlockHeight: vm.hints().lastValidBlockHeight,
      slot: vm.hints().recentSlot,
    }),
  };
  const sellerOptions: BatchSellerOptions = {
    terms,
    authorizer: vm.authorizer,
    now,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller'),
    facilitator: batchFacilitatorFor(vm.signer, terms),
    observe,
    closing: async (id) =>
      (await readers.channelState(id))?.status ===
      UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
    observeOpening: async (opening) => {
      const channel = await readers.channelState(opening.voucher!.channelId);
      if (
        channel?.status !== UPTO_CHANNEL_ACCOUNT.statuses.OPEN ||
        channel.depositAtomic !== terms.depositAtomic
      )
        return false;
      const bytes = getTransactionDecoder().decode(
        Buffer.from(opening.deposit.transaction, 'base64'),
      ).messageBytes;
      return vm.history
        .signatures(opening.voucher!.channelId)
        .some(
          (entry) =>
            vm.signatureSucceeded(entry.signature) &&
            vm.history.message(entry.signature)?.equals(Buffer.from(bytes)),
        );
    },
    minSettlementAtomic: '100',
    idleMs: 1000,
    pollMs: 20,
  };
  const buyer = await createBatchBuyer(buyerOptions);
  let seller = await createBatchSeller(sellerOptions);
  return {
    vm,
    root,
    terms,
    before,
    buyer,
    owner: vm.seller,
    observe,
    seller: () => seller,
    async restart() {
      await seller.dispose();
      seller = await createBatchSeller(sellerOptions);
    },
    async dispose() {
      await buyer.dispose();
      await seller.dispose();
    },
  };
}
