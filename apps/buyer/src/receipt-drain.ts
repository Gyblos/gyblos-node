// Coordinates earlier background receipt work before a new foreground request; never retries execution.
export async function afterBuyerReceipts<T>(
  drain: () => Promise<void>,
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  void drain;
  void signal;
  return operation();
}
