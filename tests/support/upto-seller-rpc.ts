// The seller's payment RPC, offline: no channel accounts, every recipient token account present
// unless `missing` says so, and a creation that is recorded and lands, or is refused with `refuse`.
import {
  getBase58Decoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type Blockhash,
} from '@solana/kit';
import { UPTO_TOKEN_ACCOUNT } from 'x402-upto-metered';

import { DEVNET_GENESIS, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import type { UptoSellerPaymentsOptions } from '@gyblos/payments-upto';

// An initialized token account's data (165 bytes).
const bytes = new Uint8Array(165);
bytes[UPTO_TOKEN_ACCOUNT.stateOffset] = UPTO_TOKEN_ACCOUNT.initialized;
const INITIALIZED_TOKEN_ACCOUNT = Buffer.from(bytes).toString('base64');

export function offline(
  chain: { missing?: boolean; refuse?: boolean; genesis?: string } = {},
) {
  const sent: string[] = [];
  const rpc: NonNullable<UptoSellerPaymentsOptions['rpc']> = {
    getGenesisHash: () => ({
      send: async () => chain.genesis ?? DEVNET_GENESIS,
    }),
    getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    getMultipleAccounts: (accounts: readonly Address[]) => ({
      send: async () => ({
        value: accounts.map(() =>
          chain.missing
            ? null
            : {
                owner: TOKEN_PROGRAM_ADDRESS,
                data: [INITIALIZED_TOKEN_ACCOUNT, 'base64'] as const,
              },
        ),
      }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: getBase58Decoder().decode(
            new Uint8Array(32).fill(9),
          ) as Blockhash,
          lastValidBlockHeight: 900n,
        },
      }),
    }),
    sendTransaction: (wire) => ({
      send: async () => {
        if (chain.refuse) throw new Error('send refused');
        sent.push(wire);
        chain.missing = false;
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(Buffer.from(wire, 'base64')),
        );
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ err: null, confirmationStatus: 'confirmed' as const }],
      }),
    }),
    getSlot: () => ({ send: async () => 1n }),
  };
  return { rpc, sent };
}
