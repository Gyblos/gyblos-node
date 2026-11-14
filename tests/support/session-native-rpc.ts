// RPC projection of actual LiteSVM transactions/account bytes; every send stays inside the synthetic VM.
import assert from 'node:assert/strict';

import {
  address,
  signature as asSignature,
  type Address,
  type createSolanaRpc,
  type Signature,
} from '@solana/kit';

import type { nativeVm } from './paid-native-vm';

export function sessionNativeRpc(vm: Awaited<ReturnType<typeof nativeVm>>) {
  let wrongGenesis = false;
  let hideOriginal = false;
  let wrongFee = false;
  let incomplete = false;
  let loseSendReply = false;
  let outgoing: (wire: string) => Promise<void> = async () => {};
  const rpc = {
    getGenesisHash: () => ({
      send: async () =>
        wrongGenesis
          ? 'wrong'
          : vm.network.slice('solana:'.length) + '111111111111',
    }),
    getSlot: () => ({ send: async () => vm.slot() }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: vm.hints().recentBlockhash,
          lastValidBlockHeight: BigInt(vm.hints().lastValidBlockHeight),
        },
      }),
    }),
    getEpochInfo: (config: { commitment: string }) => ({
      send: async () => {
        assert.equal(config.commitment, 'finalized');
        return { absoluteSlot: vm.slot(), blockHeight: vm.height() };
      },
    }),
    minimumLedgerSlot: () => ({ send: async () => vm.history.oldestSlot }),
    getFirstAvailableBlock: () => ({ send: async () => vm.history.oldestSlot }),
    getSignaturesForAddress: (
      id: Address,
      config: { commitment: string; before?: string; limit: number },
    ) => ({
      send: async () => {
        assert.equal(config.commitment, 'finalized');
        const found = vm.history.signatures(
          id,
          incomplete ? undefined : config.before,
          config.limit,
        );
        return incomplete && found.length
          ? Array.from({ length: config.limit }, () => found[0])
          : found;
      },
    }),
    getAccountInfo: (id: Address, config: { commitment: string }) => ({
      send: async () => {
        assert.equal(config.commitment, 'finalized');
        return {
          value: await vm.accountInfo(address(id), vm.network),
          context: { slot: vm.slot() },
        };
      },
    }),
    getBlockTime: () => ({ send: async () => vm.blockTime() }),
    getSignatureStatuses: (signatures: Signature[]) => ({
      send: async () => ({
        context: { slot: vm.slot() },
        value: signatures.map((id) =>
          vm.signatureSucceeded(id)
            ? { err: null, confirmationStatus: 'finalized', slot: vm.slot() }
            : null,
        ),
      }),
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        await outgoing(wire);
        const sent = await vm.signer.sendTransaction(wire, vm.network);
        if (loseSendReply) throw new Error('Synthetic send reply lost');
        return asSignature(sent);
      },
    }),
    getTransaction: (
      id: Signature,
      config: { encoding: string; commitment: string },
    ) => ({
      send: async () => {
        assert.equal(config.commitment, 'finalized');
        const found = vm.history.transaction(id);
        if (!found) return null;
        if (config.encoding === 'base64') {
          const wire = vm.history.encodedTransaction(id);
          return !wire || hideOriginal
            ? null
            : { ...found, transaction: [wire, 'base64'] };
        }
        if (!wrongFee) return found;
        return {
          ...found,
          meta: {
            ...found.meta,
            postTokenBalances: found.meta.postTokenBalances.map((balance) =>
              balance.owner === vm.fee.address
                ? { ...balance, uiTokenAmount: { amount: '999999' } }
                : balance,
            ),
          },
        };
      },
    }),
  } as unknown as ReturnType<typeof createSolanaRpc>;
  return {
    rpc,
    beforeSend: (handler: (wire: string) => Promise<void>) => {
      outgoing = handler;
    },
    loseSendReply: (value: boolean) => {
      loseSendReply = value;
    },
    wrongGenesis: (value: boolean) => {
      wrongGenesis = value;
    },
    hideOriginal: (value: boolean) => {
      hideOriginal = value;
    },
    wrongFee: (value: boolean) => {
      wrongFee = value;
    },
    incomplete: (value: boolean) => {
      incomplete = value;
    },
  };
}
