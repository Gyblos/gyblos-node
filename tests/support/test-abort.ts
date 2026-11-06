// Synthetic service cancellation: test helpers must also observe cancellation before listener registration.
export function waitForTestAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
