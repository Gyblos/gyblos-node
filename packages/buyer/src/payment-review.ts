import { setTimeout as delay } from 'node:timers/promises';

import { bounded } from '@gyblos/node/buyer-operation';

import { PAYMENT_REVIEW } from './constants';

export async function reviewPayment<T>(
  observe: (signal: AbortSignal) => Promise<T | undefined>,
) {
  const deadline = AbortSignal.timeout(PAYMENT_REVIEW.deadlineMs);
  const started = performance.now();
  for (const offset of PAYMENT_REVIEW.offsetsMs) {
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
