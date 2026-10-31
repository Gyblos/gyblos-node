// The finalized transactions that touched a channel's address, oldest first, for reconciliation: an
// address no transaction ever touched was never opened. Failed transactions are left out. No Gyblos
// imports; no writes.
import { address, type Address, type Signature } from '@solana/kit';

import {
  UPTO_ERROR_CODES,
  UPTO_FINAL_COMMITMENT,
  UPTO_HISTORY_LIMIT,
} from './constants';
import { UptoError } from './errors';

// The slice of a @solana/kit RPC the history uses.
export interface UptoSignaturesRpc {
  getSignaturesForAddress(
    account: Address,
    config: { commitment: typeof UPTO_FINAL_COMMITMENT; limit: number },
  ): {
    send(): Promise<readonly { signature: Signature; err: unknown }[]>;
  };
}

export function createUptoChannelHistory(rpc: UptoSignaturesRpc) {
  return {
    async signatures(channelId: string): Promise<string[]> {
      let found: readonly { signature: Signature; err: unknown }[];
      try {
        found = await rpc
          .getSignaturesForAddress(address(channelId), {
            commitment: UPTO_FINAL_COMMITMENT,
            limit: UPTO_HISTORY_LIMIT,
          })
          .send();
      } catch {
        throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
      }
      // The RPC lists newest first.
      return found
        .filter((entry) => entry.err === null)
        .map((entry) => String(entry.signature))
        .reverse();
    },
  };
}
