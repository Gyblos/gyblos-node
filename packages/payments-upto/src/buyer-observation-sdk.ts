// Passes a single observation deadline to each Solana SDK read; never sends a transaction.
import { createSolanaRpc } from '@solana/kit';

import type { UptoReconcileOptions } from './buyer-reconcile';

export function observationSdk(
  rpc: ReturnType<typeof createSolanaRpc>,
  signal: AbortSignal,
): UptoReconcileOptions['rpc'] {
  return {
    getGenesisHash: () => ({
      send: (config) =>
        rpc.getGenesisHash().send({
          abortSignal: config?.abortSignal
            ? AbortSignal.any([signal, config.abortSignal])
            : signal,
        }),
    }),
    getSignaturesForAddress: (account, config) => ({
      send: () =>
        rpc
          .getSignaturesForAddress(account, config)
          .send({ abortSignal: signal }),
    }),
    getEpochInfo: (config) => ({
      send: () => rpc.getEpochInfo(config).send({ abortSignal: signal }),
    }),
    minimumLedgerSlot: () => ({
      send: () => rpc.minimumLedgerSlot().send({ abortSignal: signal }),
    }),
    getFirstAvailableBlock: () => ({
      send: () => rpc.getFirstAvailableBlock().send({ abortSignal: signal }),
    }),
    getAccountInfo: (account, config) => ({
      send: () =>
        rpc.getAccountInfo(account, config).send({ abortSignal: signal }),
    }),
    getTransaction: (signature, config) => ({
      send: () =>
        rpc.getTransaction(signature, config).send({ abortSignal: signal }),
    }),
  };
}
