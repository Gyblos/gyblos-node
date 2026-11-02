// The seller's payment RPC, offline: no channel accounts, every recipient token account present
// unless `missing` says so, and a creation that is recorded and lands, or is refused with `refuse`.
import { getBase58Decoder, type Blockhash } from '@solana/kit';

import { TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';

export function offline(chain: { missing?: boolean; refuse?: boolean } = {}) {
  const sent: string[] = [];
  const rpc = {
    getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    getMultipleAccounts: (accounts: readonly string[]) => ({
      send: async () => ({
        value: accounts.map(() =>
          chain.missing ? null : { owner: TOKEN_PROGRAM_ADDRESS },
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
    sendTransaction: (wire: string) => ({
      send: async () => {
        if (chain.refuse) throw new Error('send refused');
        sent.push(wire);
        chain.missing = false;
        return getBase58Decoder().decode(new Uint8Array(64).fill(1));
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ err: null, confirmationStatus: 'confirmed' }],
      }),
    }),
    getSlot: () => ({ send: async () => 1n }),
  };
  return { rpc: rpc as never, sent };
}
