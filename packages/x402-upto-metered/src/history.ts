// What finalized chain history says about a channel address, for reconciliation: its successful
// transactions oldest first (paged to the end, or marked incomplete past a bound), the finalized block
// height, the oldest slot the RPC still holds, and whether the account exists. No Gyblos imports.
import { address, type Address, type Signature } from '@solana/kit';

import {
  UPTO_ERROR_CODES,
  UPTO_FINAL_COMMITMENT,
  UPTO_HISTORY_LIMIT,
  UPTO_HISTORY_PAGES,
} from './constants';
import { UptoError } from './errors';

type Final = { commitment: typeof UPTO_FINAL_COMMITMENT };

// The slice of a @solana/kit RPC the history uses.
export interface UptoSignaturesRpc {
  getSignaturesForAddress(
    account: Address,
    config: Final & { limit: number; before?: Signature },
  ): {
    send(): Promise<readonly { signature: Signature; err: unknown }[]>;
  };
  getBlockHeight(config: Final): { send(): Promise<bigint> };
  minimumLedgerSlot(): { send(): Promise<bigint> };
  getAccountInfo(
    account: Address,
    config: Final & { encoding: 'base64' },
  ): { send(): Promise<{ value: unknown }> };
}

// Successful transactions only, oldest first, from the RPC's newest-first listing.
const successful = (found: readonly { signature: Signature; err: unknown }[]) =>
  found
    .filter((entry) => entry.err === null)
    .map((entry) => String(entry.signature))
    .reverse();

async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
}

export interface UptoChannelHistory {
  // Successful transactions, oldest first.
  signatures: string[];
  // False when the bound was reached first: older transactions may exist.
  complete: boolean;
}

export function createUptoChannelHistory(rpc: UptoSignaturesRpc) {
  const final = { commitment: UPTO_FINAL_COMMITMENT };
  return {
    async signatures(channelId: string): Promise<UptoChannelHistory> {
      const found: { signature: Signature; err: unknown }[] = [];
      let before: Signature | undefined;
      for (let page = 0; page < UPTO_HISTORY_PAGES; page++) {
        // The RPC lists newest first.
        const batch = await read(() =>
          rpc
            .getSignaturesForAddress(address(channelId), {
              ...final,
              limit: UPTO_HISTORY_LIMIT,
              ...(before ? { before } : {}),
            })
            .send(),
        );
        found.push(...batch);
        if (batch.length < UPTO_HISTORY_LIMIT)
          return { signatures: successful(found), complete: true };
        before = batch[batch.length - 1]!.signature;
      }
      return { signatures: successful(found), complete: false };
    },
    blockHeight: () => read(() => rpc.getBlockHeight(final).send()),
    // The oldest slot whose transactions this RPC still serves.
    oldestSlot: () => read(() => rpc.minimumLedgerSlot().send()),
    accountExists: async (channelId: string) =>
      (
        await read(() =>
          rpc
            .getAccountInfo(address(channelId), {
              ...final,
              encoding: 'base64',
            })
            .send(),
        )
      ).value !== null,
  };
}
