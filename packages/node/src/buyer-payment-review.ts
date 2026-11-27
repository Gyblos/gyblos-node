import { setTimeout as delay } from 'node:timers/promises';

import { bounded } from './buyer-operation';
import { BUYER_PAYMENT_REVIEW } from './constants';

export async function reviewPayment<T>(
  observe: (signal: AbortSignal) => Promise<T | undefined>,
  external?: AbortSignal,
) {
  const deadline =
    external ?? AbortSignal.timeout(BUYER_PAYMENT_REVIEW.deadlineMs);
  const started = performance.now();
  for (const offset of BUYER_PAYMENT_REVIEW.offsetsMs) {
    const wait = offset - (performance.now() - started);
    if (wait > 0) await delay(wait, undefined, { signal: deadline });
    if (deadline.aborted) return undefined;
    const result = await bounded(observe(deadline), deadline).catch(
      () => undefined,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}
