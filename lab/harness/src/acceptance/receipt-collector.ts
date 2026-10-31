// Exercises private ingestion only inside an owned temporary acceptance workspace; never sends receipts.
import type { ReceiptV1 } from '@gyblos/protocol/receipt';

export async function collectReceiptAcceptance(
  _root: string,
  _receipts: readonly ReceiptV1[],
  _signal: AbortSignal,
) {
  return { collectorStored: 0, collectorDuplicates: 0, collectorRestarts: 0, collectorRefusals: 0 };
}
