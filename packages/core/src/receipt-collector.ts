// Receives bounded private free-receipt pairs through an injected atomic store; never sends or executes.
import { RECEIPT_COLLECTOR_CODES, type ReceiptCollectorCode } from './constants';
import type { PrivateReceiptStore, ReceiptCollectorResult } from './receipt-collector-types';

export type * from './receipt-collector-types';
export class ReceiptCollectorError extends Error {
  constructor(readonly code: ReceiptCollectorCode) {
    super(code);
    this.name = 'ReceiptCollectorError';
  }
}
export function createPrivateReceiptCollector(_store: PrivateReceiptStore) {
  return {
    async collect(_body: Uint8Array, _signal?: AbortSignal): Promise<ReceiptCollectorResult> {
      throw new ReceiptCollectorError(RECEIPT_COLLECTOR_CODES.INVALID);
    },
  };
}
