// Bounds one read-only payment observation and prevents new RPC reads after cancellation.
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import type { UptoReconcileOptions } from './buyer-reconcile';

export async function beforeAbort<T>(
  signal: AbortSignal,
  call: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
  let abort = () => {};
  try {
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE));
      signal.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted)
          throw new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
        return call();
      }),
      stopped,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function observationRpc(
  rpc: UptoReconcileOptions['rpc'],
  signal: AbortSignal,
): UptoReconcileOptions['rpc'] {
  return {
    getGenesisHash: () => ({
      send: (config) =>
        beforeAbort(signal, () =>
          rpc.getGenesisHash().send({
            abortSignal: config?.abortSignal
              ? AbortSignal.any([signal, config.abortSignal])
              : signal,
          }),
        ),
    }),
    getSignaturesForAddress: (account, config) => ({
      send: () =>
        beforeAbort(signal, () =>
          rpc.getSignaturesForAddress(account, config).send(),
        ),
    }),
    getEpochInfo: (config) => ({
      send: () => beforeAbort(signal, () => rpc.getEpochInfo(config).send()),
    }),
    minimumLedgerSlot: () => ({
      send: () => beforeAbort(signal, () => rpc.minimumLedgerSlot().send()),
    }),
    getFirstAvailableBlock: () => ({
      send: () =>
        beforeAbort(signal, () => rpc.getFirstAvailableBlock().send()),
    }),
    getAccountInfo: (account, config) => ({
      send: () =>
        beforeAbort(signal, () => rpc.getAccountInfo(account, config).send()),
    }),
    getTransaction: (signature, config) => ({
      send: () =>
        beforeAbort(signal, () => rpc.getTransaction(signature, config).send()),
    }),
  };
}
