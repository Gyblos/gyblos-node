// Waits for receipt work to settle before observing private snapshots; no storage, clocks or native setup.
import assert from 'node:assert/strict';

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
  signal.throwIfAborted();
  await observation.wait(() => {
    const current = observation.health();
    assert.equal(current.failed, before.failed);
    assert.equal(current.dropped, before.dropped);
    assert.ok(
      current.saved >= before.saved && current.saved <= before.saved + 1,
    );
    return !current.active && current.saved === before.saved + 1;
  }, signal);
  signal.throwIfAborted();
  const found = await observation.read(signal);
  signal.throwIfAborted();
  return found;
}
