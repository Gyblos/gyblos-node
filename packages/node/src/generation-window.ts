// Bounds one generation by a permit's deadline. A late engine result is observed but cannot keep
// publishing or revise what was measured; without a deadline only the request's own signal applies.
// The caller names its wire's errors, so free and paid keep their own codes.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';

export interface GenerationWindowErrors {
  timeout: Error;
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
    async run(operation) {
      await Promise.resolve();
      if (request.aborted) throw errors.cancelled();
      return operation();
    },
  };
}

export function generationWindow(
  deadline: number | undefined,
  now: () => number,
  request: AbortSignal,
  errors: GenerationWindowErrors,
): GenerationWindow {
  if (deadline === undefined) return unbounded(request, errors);
  const controller = new AbortController();
  const signal = AbortSignal.any([request, controller.signal]);
  let expire = () => controller.abort(errors.timeout);
  const check = () => {
    if (now() >= deadline) {
      expire();
      throw errors.timeout;
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
          controller.abort(errors.timeout);
          reject(errors.timeout);
        };
        timer = setTimeout(
          expire,
          Math.max(0, Math.min(deadline - now(), TRANSPORT_TIMEOUTS.requestMs)),
        );
      });
      const running = Promise.resolve().then(() => {
        check();
        if (request.aborted) throw errors.cancelled();
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
