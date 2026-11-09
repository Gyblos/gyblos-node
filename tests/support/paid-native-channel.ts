// Contract for the offline SDK/native-program acceptance fixture. No RPC or product startup.
import assert from 'node:assert/strict';

import { getCloseAccountInstruction } from '@solana-program/token';
import { address } from '@solana/kit';
import {
  createUptoAuthorization,
  createUptoChannelReaders,
  createUptoFacilitator,
  createUptoSdkChain,
  createUptoSeller,
  createUptoVerifier,
  distributeInstruction,
  memoryUptoChainStore,
  memoryUptoStore,
  requestCloseInstruction,
  sealInstruction,
  UPTO_PROGRAM,
  uptoClaimUntil,
  uptoTokenAccount,
  type UptoChannelOnChain,
  type UptoSettlement,
  type UptoTerms,
  type UptoWithdrawResult,
} from 'x402-upto-metered';

import { PROTOCOL_FEE, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { PAYMENT_BINDING } from '@gyblos/protocol/constants';

import { nativeVm } from './paid-native-vm';
import {
  nativeWithdrawal,
  type NativeWithdrawFault,
} from './paid-native-withdrawal';

export interface NativeBalances {
  payer: bigint;
  seller: bigint;
  fee: bigint;
  program: bigint;
  escrow: bigint;
}

export interface NativeChannel {
  expiresAt: number;
  sends(): number;
  open(): Promise<void>;
  close(): Promise<void>;
  seal(): Promise<void>;
  closeRefundAccount(): Promise<void>;
  withdraw(fault?: NativeWithdrawFault): Promise<UptoWithdrawResult>;
  withdrawalSignature(): string | undefined;
  claim(amount: string): Promise<UptoSettlement>;
  balances(): Promise<NativeBalances>;
  channel(): Promise<UptoChannelOnChain | undefined>;
  atInclusion(seconds: number): void;
  time(seconds: number): void;
  loseConfirmation(value: boolean): void;
  failureCode(): number | undefined;
  refund(): Promise<void>;
  replay(): Promise<boolean>;
}

export async function nativeChannel(options: {
  now: () => number;
  grace?: number;
  deposit?: string;
}): Promise<NativeChannel> {
  const vm = await nativeVm(options.now);

  const terms: UptoTerms = {
    network: vm.network,
    asset: vm.mint.address,
    payTo: vm.seller.address,
    feePayer: vm.feePayer.address,
    authorizer: vm.authorizer.address,
    tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
    maxAtomic: options.deposit ?? '1000',
    expiresAt: options.now() + 30_000,
    memo: 'synthetic-native-acceptance',
    withdrawDelaySeconds:
      options.grace ?? UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds,
    maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
    splits: [
      {
        recipient: vm.seller.address,
        bps: PAYMENT_BINDING.bpsDenominator - PROTOCOL_FEE.bps,
      },
      { recipient: vm.fee.address, bps: PROTOCOL_FEE.bps },
    ],
  };
  const authorization = await createUptoAuthorization(
    vm.payer,
    terms,
    vm.hints(),
  );
  const readers = createUptoChannelReaders(
    {
      async getAccountInfo(channelId) {
        const found = await vm.accountInfo(address(channelId), vm.network);
        if (!found) return null;
        assert.ok(
          Array.isArray(found.data) && typeof found.data[0] === 'string',
        );
        const data: [string, 'base64'] = [found.data[0], 'base64'];
        return { owner: found.owner, data };
      },
      signaturesSucceeded: async (signatures) =>
        signatures.map(vm.signatureSucceeded),
    },
    { network: terms.network, rentPayer: vm.feePayer.address },
  );
  const chainStore = memoryUptoChainStore();
  const facilitator = createUptoFacilitator(vm.signer, chainStore);
  const chain = createUptoSdkChain({
    facilitator,
    verify: createUptoVerifier(vm.feePayer.address, async () => vm.slot()),
    authorizer: vm.authorizer,
    store: chainStore,
    channelExists: readers.channelExists,
    settledClaim: readers.settledClaim,
    now: options.now,
    openWindowMs: 90_000,
    recipients: {
      ensure: async () => {
        // Prerequisites were created by real token transactions; never fabricate token-account bytes.
        for (const owner of [
          vm.payer.address,
          vm.seller.address,
          vm.fee.address,
          vm.feePayer.address,
          UPTO_PROGRAM.treasuryOwners.mainnet,
        ])
          await vm.requireAccount(owner);
      },
    },
  });
  const seller = createUptoSeller({
    chain,
    store: memoryUptoStore(),
    now: options.now,
    own: terms,
  });
  const withdrawal = nativeWithdrawal(vm, terms.tokenProgram);
  return {
    expiresAt: uptoClaimUntil(authorization) / 1000,
    sends: vm.sends,
    open: async () => {
      await seller.admit(authorization, terms, { minClaimWindowMs: 20_000 });
    },
    close: () =>
      vm.send([requestCloseInstruction(vm.payer, authorization.channelId)]),
    seal: () => vm.send([sealInstruction(authorization.channelId)]),
    closeRefundAccount: async () =>
      vm.send([
        getCloseAccountInstruction({
          account: await uptoTokenAccount(
            vm.payer.address,
            vm.mint.address,
            terms.tokenProgram,
          ),
          destination: vm.payer.address,
          owner: vm.payer,
        }),
      ]),
    withdraw: (fault) =>
      withdrawal.withdraw(
        {
          channelId: authorization.channelId,
          mint: vm.mint.address,
          rentPayer: vm.feePayer.address,
          maxAtomic: terms.maxAtomic,
          splits: terms.splits ?? [],
        },
        fault,
      ),
    withdrawalSignature: withdrawal.signature,
    claim: (amount) => seller.settle(authorization.channelId, amount),
    async balances() {
      const [payer, sellerBalance, fee, program, escrow] = await Promise.all(
        [
          vm.payer.address,
          vm.seller.address,
          vm.fee.address,
          UPTO_PROGRAM.treasuryOwners.mainnet,
          authorization.channelId,
        ].map(vm.balance),
      );
      assert.ok(
        payer !== undefined &&
          sellerBalance !== undefined &&
          fee !== undefined &&
          program !== undefined &&
          escrow !== undefined,
      );
      return { payer, seller: sellerBalance, fee, program, escrow };
    },
    channel: () => readers.channelState(authorization.channelId),
    atInclusion: vm.atInclusion,
    time: vm.time,
    loseConfirmation: vm.loseConfirmation,
    failureCode: vm.failureCode,
    async refund() {
      await vm.send([
        sealInstruction(authorization.channelId),
        await distributeInstruction({
          channelId: authorization.channelId,
          payer: vm.payer.address,
          payee: vm.feePayer.address,
          rentPayer: vm.feePayer.address,
          mint: vm.mint.address,
          tokenProgram: terms.tokenProgram,
          network: terms.network,
          splits: terms.splits ?? [],
        }),
      ]);
    },
    replay: vm.replay,
  };
}
