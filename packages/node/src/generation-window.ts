// Bounds one generation by a permit's deadline, capped at the transport's request limit. A late engine
// result is observed but cannot keep publishing or revise what was measured; without a deadline only
// the request's own signal applies. The caller names its wire's errors, so free and paid keep their own
// codes. The slot is released once the run ends, even if an engine ignores the abort, as before.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';

export interface GenerationWindowErrors {
  // A fresh error per window, so no request's error is shared with another's.
  timeout: () => Error;
  cancelled: () => Error;
}

export interface GenerationWindow {
  signal: AbortSignal;
  // Throws the timeout once the deadline has passed.
  check: () => void;
  run<T>(operation: () => Promise<T>, stop: () => void): Promise<T>;
}

function unbounded(
  request: AbortSignal,
  errors: GenerationWindowErrors,
): GenerationWindow {
  return {
    signal: request,
    check: () => {},
    run(operation) {
      // No extra tick: cancellation is checked right before the engine starts, as before.
      if (request.aborted) return Promise.reject(errors.cancelled());
      try {
        return operation();
      } catch (error) {
        // A synchronous throw is measured like a rejection, as it is with a deadline.
        return Promise.reject(error);
      }
    },
  };
}

export function generationWindow(
  deadline: number | undefined,
  now: () => number,
  request: AbortSignal,
  errors: GenerationWindowErrors,
  cancelOnAbort = false,
): GenerationWindow {
  if (deadline === undefined) return unbounded(request, errors);
  // A policy bug, not a timeout: the caller reports it as an internal failure that charges nothing.
  if (!Number.isSafeInteger(deadline) || deadline <= 0)
    throw new RangeError('invalid generation deadline');
  const controller = new AbortController();
  const timeout = errors.timeout();
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
      // stop runs at most once, and only while the engine runs: never before it started, again for
      // late deltas, or after the run ended.
      let started = false;
      let ended = false;
      const halt = () => {
        if (started && !ended) {
          ended = true;
          try {
            stop();
          } catch {
            /* Publication still ends if a stop hook fails. */
          }
        }
      };
      let abort = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          halt();
          reject(errors.cancelled());
        };
        if (cancelOnAbort)
          request.addEventListener('abort', abort, { once: true });
      });
      const expired = new Promise<never>((_resolve, reject) => {
        expire = () => {
          halt();
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
        if (request.aborted) throw errors.cancelled();
        started = true;
        return operation();
      });
      try {
        return await Promise.race([running, expired, cancelled]);
      } finally {
        ended = true;
        clearTimeout(timer);
        request.removeEventListener('abort', abort);
      }
    },
  };
}
