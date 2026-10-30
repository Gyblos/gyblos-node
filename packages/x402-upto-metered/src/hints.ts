// The buyer's hints for signing a channel open offline: the latest blockhash with its last valid height
// and the current slot, read only after the RPC proved (once) that it serves the terms' network. RPC
// failures are UNAVAILABLE and never carry the RPC's text. No Gyblos imports.
import {
  UPTO_COMMITMENT,
  UPTO_ERROR_CODES,
  UPTO_SOLANA_NAMESPACE,
  UPTO_SOLANA_REFERENCE_LENGTH,
} from './constants';
import { UptoError } from './errors';
import type { UptoClientHints, UptoTerms } from './types';

// The slice of a @solana/kit RPC the reader uses.
export interface UptoHintRpc {
  getGenesisHash(): { send(): Promise<string> };
  getLatestBlockhash(config: { commitment: typeof UPTO_COMMITMENT }): {
    send(): Promise<{
      value: { blockhash: string; lastValidBlockHeight: bigint };
    }>;
  };
  getSlot(config: { commitment: typeof UPTO_COMMITMENT }): {
    send(): Promise<bigint>;
  };
}

async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
}

export function createUptoHintReader(
  rpc: UptoHintRpc,
  network: UptoTerms['network'],
) {
  // A CAIP-2 Solana network is `solana:` and the genesis hash's first 32 characters.
  const [namespace, reference = ''] = network.split(':');
  let proven: Promise<void> | undefined;
  const prove = async () => {
    const genesis = await read(() => rpc.getGenesisHash().send());
    if (
      namespace !== UPTO_SOLANA_NAMESPACE ||
      String(genesis).slice(0, UPTO_SOLANA_REFERENCE_LENGTH) !== reference
    )
      throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  };
  return {
    async hints(): Promise<UptoClientHints> {
      // A failed proof is retried on the next call; a passed one holds for the reader's life.
      proven ??= prove().catch((error: unknown) => {
        proven = undefined;
        throw error;
      });
      await proven;
      const { value } = await read(() =>
        rpc.getLatestBlockhash({ commitment: UPTO_COMMITMENT }).send(),
      );
      const slot = await read(() =>
        rpc.getSlot({ commitment: UPTO_COMMITMENT }).send(),
      );
      return {
        recentBlockhash: String(value.blockhash),
        lastValidBlockHeight: String(value.lastValidBlockHeight),
        recentSlot: String(slot),
      };
    },
  };
}
