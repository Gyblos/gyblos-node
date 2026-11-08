// Bounds paid generation by the adapter's claim cutoff, reserving settlement time. A late engine
// result is observed but cannot keep publishing or revise the charge; chain confirmation is separate.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { PaidExecutionError } from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

export function paidGenerationWindow(
  claimUntil: number,
  reserveMs: number,
  now: () => number,
  request: AbortSignal,
) {
  if (
    !Number.isSafeInteger(claimUntil) ||
    claimUntil <= 0 ||
    !Number.isSafeInteger(reserveMs) ||
    reserveMs <= 0
  )
    throw new PaidExecutionError(PAID_EXECUTION_CODES.INTERNAL);
  const deadline = claimUntil - reserveMs;
  const controller = new AbortController();
  const timeout = new PaidExecutionError(PAID_EXECUTION_CODES.TIMEOUT);
  const signal = AbortSignal.any([request, controller.signal]);
  let expire = () => controller.abort(timeout);
  const check = () => {
    if (now() >= deadline) {
      expire();
      throw timeout;
    }
  };
  return {
    signal,
    check,
    async run<T>(operation: () => Promise<T>, stop: () => void): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        expire = () => {
          stop();
          controller.abort(timeout);
          reject(timeout);
        };
        timer = setTimeout(
          expire,
          Math.max(0, Math.min(deadline - now(), TRANSPORT_TIMEOUTS.requestMs)),
        );
      });
      const running = Promise.resolve().then(() => {
        check();
        if (request.aborted)
          throw new PaidExecutionError(PAID_EXECUTION_CODES.CANCELLED);
        return operation();
      });
      try {
        return await Promise.race([running, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
