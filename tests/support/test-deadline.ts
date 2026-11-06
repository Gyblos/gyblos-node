// Test watchdogs are independent of native capability setup and preserve the existing timeout value.
import { setTimeout as delay } from 'node:timers/promises';

export class NativeTestDeadlineError extends Error {
  constructor() { super('Synthetic native test deadline exceeded'); this.name = 'NativeTestDeadlineError'; }
}
export async function within<T>(operation: Promise<T>, milliseconds = 3500) {
  const controller = new AbortController();
  try { return await Promise.race([operation, delay(milliseconds, undefined, { signal: controller.signal }).then(() => { throw new NativeTestDeadlineError(); })]); }
  finally { controller.abort(); }
}
