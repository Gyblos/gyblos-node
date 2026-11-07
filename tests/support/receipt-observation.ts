// Waits for receipt work to settle before observing private snapshots; no storage, clocks or native setup.
import type { createBuyerReceiptRuntime } from '@gyblos/node/receipts';

type ReceiptHealth = ReturnType<
  ReturnType<typeof createBuyerReceiptRuntime>['health']
>;
interface ReceiptObservation<T> {
  health(): ReceiptHealth;
  read(signal: AbortSignal): Promise<T>;
  wait(ready: () => boolean, signal: AbortSignal): Promise<void>;
}
export async function observeReceipt<T>(
  observation: ReceiptObservation<T>,
  before: ReceiptHealth,
  signal: AbortSignal,
): Promise<T> {
  return observation.read(signal);
}
