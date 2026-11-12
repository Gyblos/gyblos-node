// Coordinates earlier background receipt work before a new foreground request; never retries execution.
import { bounded } from '@gyblos/node/buyer-operation';

export async function afterBuyerReceipts<T>(
  drain: () => Promise<void>,
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  await bounded(drain(), signal);
  signal.throwIfAborted();
  return operation();
}
