// Receives bounded private free-receipt pairs through an injected atomic store; never sends or executes.
import {
  RECEIPT_COLLECTOR_CODES,
  RECEIPT_COLLECTOR_LIMITS,
  RECEIPT_COLLECTOR_STATUSES,
  RECEIPT_COLLECTOR_WRITES,
} from './constants';
import { collectorFail, collectorSignal } from './receipt-collector-errors';
import type {
  PrivateFreeReceipt,
  PrivateReceiptStore,
  ReceiptCollectorResult,
} from './receipt-collector-types';
import { prepareCollectedReceipt } from './receipt-collector-validation';

export type * from './receipt-collector-types';
export { ReceiptCollectorError } from './receipt-collector-errors';

async function storeReceipt(
  store: PrivateReceiptStore,
  entry: PrivateFreeReceipt,
  signal?: AbortSignal,
): Promise<ReceiptCollectorResult> {
  let outcome;
  try {
    outcome = await store.insert(entry, signal);
  } catch {
    collectorSignal(signal);
    return collectorFail(RECEIPT_COLLECTOR_CODES.STORAGE);
  }
  collectorSignal(signal);
  if (outcome === RECEIPT_COLLECTOR_WRITES.INSERTED)
    return { status: RECEIPT_COLLECTOR_STATUSES.STORED };
  if (outcome === RECEIPT_COLLECTOR_WRITES.IDENTICAL)
    return { status: RECEIPT_COLLECTOR_STATUSES.DUPLICATE };
  if (outcome === RECEIPT_COLLECTOR_WRITES.CONFLICT)
    return collectorFail(RECEIPT_COLLECTOR_CODES.CONFLICT);
  if (outcome === RECEIPT_COLLECTOR_WRITES.FULL)
    return collectorFail(RECEIPT_COLLECTOR_CODES.LIMIT);
  return collectorFail(RECEIPT_COLLECTOR_CODES.STORAGE);
}
export function createPrivateReceiptCollector(store: PrivateReceiptStore) {
  let active = 0;
  return {
    async collect(
      body: Uint8Array,
      signal?: AbortSignal,
    ): Promise<ReceiptCollectorResult> {
      collectorSignal(signal);
      if (active >= RECEIPT_COLLECTOR_LIMITS.active)
        return collectorFail(RECEIPT_COLLECTOR_CODES.BUSY);
      active++;
      try {
        const entry = await prepareCollectedReceipt(body);
        collectorSignal(signal);
        return await storeReceipt(store, entry, signal);
      } finally {
        // Do not release early on cancellation while the backend/crypto is still running.
        active--;
      }
    },
  };
}
