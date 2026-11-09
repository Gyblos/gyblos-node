// The real withdrawal adapter over the existing synthetic LiteSVM signer/account ports.
// Only RPC replies/failures are injected; native transactions alone change channel state and funds.
import assert from 'node:assert/strict';

import {
  address,
  blockhash,
  signature,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from '@solana/kit';
import {
  createUptoWithdrawal,
  UPTO_COMMITMENT,
  type UptoWithdrawQuery,
  type UptoWithdrawRpc,
} from 'x402-upto-metered';

import type { nativeVm } from './paid-native-vm';

export interface NativeWithdrawFault {
  loseReply?: boolean;
  // A deliberately incorrect RPC clock; simulation still uses the actual native Clock.
  blockTime?: bigint;
}

export function nativeWithdrawal(
  vm: Awaited<ReturnType<typeof nativeVm>>,
  tokenProgram: string,
) {
  let lastSignature: string | undefined;
  return {
    signature: () => lastSignature,
    async withdraw(query: UptoWithdrawQuery, fault: NativeWithdrawFault = {}) {
      const rpc: UptoWithdrawRpc = {
        getAccountInfo: (account) => ({
          async send() {
            const found = await vm.accountInfo(account, vm.network);
            if (!found) return { value: null };
            assert.ok(
              Array.isArray(found.data) && typeof found.data[0] === 'string',
            );
            const data: [string, 'base64'] = [found.data[0], 'base64'];
            return { value: { owner: address(found.owner), data } };
          },
        }),
        getSlot: () => ({ send: async () => vm.slot() }),
        getBlockTime: () => ({
          send: async () => fault.blockTime ?? vm.blockTime(),
        }),
        getLatestBlockhash: () => ({
          async send() {
            const hints = vm.hints();
            return {
              value: {
                blockhash: blockhash(hints.recentBlockhash),
                lastValidBlockHeight: BigInt(hints.lastValidBlockHeight),
              },
            };
          },
        }),
        sendTransaction: (wire) => ({
          async send() {
            try {
              await vm.signer.simulateTransaction(wire, vm.network, {
                sigVerify: true,
              });
            } catch {
              throw new SolanaError(
                SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
                {
                  accounts: null,
                  loadedAccountsDataSize: null,
                  logs: null,
                  replacementBlockhash: null,
                  returnData: null,
                  unitsConsumed: null,
                },
              );
            }
            const sent = await vm.signer.sendTransaction(wire, vm.network);
            lastSignature = sent;
            if (fault.loseReply)
              throw new Error('Synthetic lost native send reply');
            return signature(sent);
          },
        }),
        getSignatureStatuses: (signatures) => ({
          send: async () => ({
            value: signatures.map((value) =>
              vm.signatureSucceeded(value)
                ? { err: null, confirmationStatus: UPTO_COMMITMENT }
                : null,
            ),
          }),
        }),
      };
      // Recreate the adapter on every call: no in-memory withdrawal state is carried across runs.
      return createUptoWithdrawal(rpc, {
        payer: vm.payer,
        network: vm.network,
        tokenProgram,
        sleep: async () => {},
      }).withdraw(query);
    },
  };
}
