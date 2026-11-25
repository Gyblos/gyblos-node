import type { BuyerExecutionFactory } from './free-startup';

type Execute = Awaited<ReturnType<BuyerExecutionFactory>>['execute'];

export function singleSessionExecutor(execute: Execute): Execute {
  let active = false;
  const waiting = new Set<() => void>();
  return async (...args) => {
    const signal = args[1];
    signal.throwIfAborted();
    if (active) {
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
    }
    active = true;
    try {
      signal.throwIfAborted();
      return await execute(...args);
    } finally {
      const next = waiting.values().next().value;
      if (next) next();
      else active = false;
    }
  };
}
