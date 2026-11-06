// Synthetic service cancellation observes both prior and future aborts; no product policy is implemented here.
export function waitForTestAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
