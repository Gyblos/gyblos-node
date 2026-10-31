// What finalized chain history says about a channel address, for reconciliation: the finalized tip
// (read first, so later reads are at least that recent), its successful transactions oldest first, the
// oldest slot the RPC still serves, and whether the account exists. No Gyblos imports.
import { address, type Address, type Signature } from '@solana/kit';

import {
  UPTO_ERROR_CODES,
  UPTO_FINAL_COMMITMENT,
  UPTO_HISTORY_LIMIT,
  UPTO_HISTORY_PAGES,
} from './constants';
import { UptoError } from './errors';

type Final = { commitment: typeof UPTO_FINAL_COMMITMENT };
// Reads that must reflect at least the finalized tip already seen.
type AtLeast = Final & { minContextSlot?: bigint };

// The slice of a @solana/kit RPC the history uses.
export interface UptoSignaturesRpc {
  getSignaturesForAddress(
    account: Address,
    config: AtLeast & { limit: number; before?: Signature },
  ): {
    send(): Promise<readonly { signature: Signature; err: unknown }[]>;
  };
  getEpochInfo(config: Final): {
    send(): Promise<{ absoluteSlot: bigint; blockHeight: bigint }>;
  };
  minimumLedgerSlot(): { send(): Promise<bigint> };
  getFirstAvailableBlock(): { send(): Promise<bigint> };
  getAccountInfo(
    account: Address,
    config: AtLeast & { encoding: 'base64' },
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
    // The finalized slot and block height of one bank; pass the slot to the reads after it.
    async tip() {
      const epoch = await read(() => rpc.getEpochInfo(final).send());
      return { slot: epoch.absoluteSlot, height: epoch.blockHeight };
    },
    async signatures(
      channelId: string,
      minContextSlot?: bigint,
    ): Promise<UptoChannelHistory> {
      const found: { signature: Signature; err: unknown }[] = [];
      let before: Signature | undefined;
      for (let page = 0; page < UPTO_HISTORY_PAGES; page++) {
        // The RPC lists newest first.
        const batch = await read(() =>
          rpc
            .getSignaturesForAddress(address(channelId), {
              ...final,
              ...(minContextSlot === undefined ? {} : { minContextSlot }),
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
    // The oldest slot this RPC still serves both blocks and ledger for; history before it may be gone.
    async oldestSlot() {
      const ledger = await read(() => rpc.minimumLedgerSlot().send());
      const block = await read(() => rpc.getFirstAvailableBlock().send());
      return ledger > block ? ledger : block;
    },
    accountExists: async (channelId: string, minContextSlot?: bigint) =>
      (
        await read(() =>
          rpc
            .getAccountInfo(address(channelId), {
              ...final,
              ...(minContextSlot === undefined ? {} : { minContextSlot }),
              encoding: 'base64',
            })
            .send(),
        )
      ).value !== null,
  };
}
