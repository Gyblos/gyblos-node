import type { BuyerExecutionFactory } from './free-startup';

type Execute = Awaited<ReturnType<BuyerExecutionFactory>>['execute'];

export function executionSlots(limit: number) {
  let active = 0;
  const waiting = new Set<() => void>();
  return async <T>(signal: AbortSignal, run: () => Promise<T>) => {
    signal.throwIfAborted();
    if (active >= limit) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          waiting.delete(resume);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          waiting.delete(resume);
          reject(signal.reason);
        };
        waiting.add(resume);
        signal.addEventListener('abort', abort, { once: true });
      });
    } else active++;
    try {
      signal.throwIfAborted();
      return await run();
    } finally {
      const next = waiting.values().next().value;
      if (next) next();
      else active--;
    }
  };
}

export function singleSessionExecutor(execute: Execute): Execute {
  const schedule = executionSlots(1);
  return (...args) => schedule(args[1], () => execute(...args));
}
