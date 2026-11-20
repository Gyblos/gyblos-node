import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function acceptanceWait(
  check: () => boolean | Promise<boolean>,
  signal: AbortSignal,
) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    signal.throwIfAborted();
    if (await check()) return;
    await delay(10, undefined, { signal });
  }
  assert.fail('Synthetic acceptance deadline');
}
