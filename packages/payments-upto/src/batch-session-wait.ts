// Bounds SDK/RPC waits without pretending that timeout revokes a transaction already submitted.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

export async function waitBatch<T>(
  operation: Promise<T>,
  milliseconds: number = BATCH_SESSION_DEFAULTS.operationMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        sessionFail(SESSION_CODES.UNAVAILABLE);
      } catch (error) {
        reject(error);
      }
    }, milliseconds);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timer);
  }
}
