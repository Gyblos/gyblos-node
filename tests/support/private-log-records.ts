import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

export { createPrivateLog } from '@gyblos/runtime/private-log';
export { rm };
export const DIAGNOSTIC_CANARY = 'PRIVATE_SENTINEL_NEVER_LOG';
export function diagnosticBarrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function diagnosticUntil(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(
      performance.now() < deadline,
      'Diagnostic condition was not observed',
    );
    await setImmediate();
  }
}

export async function diagnosticDirectory() {
  return mkdtemp(join(await realpath(tmpdir()), 'gyblos-private-log-'));
}

export async function diagnosticRows(path: string) {
  const text = await readFile(path, 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
