// Bounds acceptance phase barriers; request cancellation and early completion must reach cleanup.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { HTTP_MULTI } from './http-multiseller-constants';
import { NativeTestDeadlineError } from './test-deadline';

export async function httpMultiPhase<T>(
  phase: Promise<T>,
  request: Promise<unknown>,
  signal: AbortSignal,
): Promise<T> {
  const lifetime = new AbortController();
  const deadline = delay(HTTP_MULTI.operationMs, undefined, {
    signal: AbortSignal.any([signal, lifetime.signal]),
  }).then(() => {
    throw new NativeTestDeadlineError();
  });
  try {
    return await Promise.race([
      phase,
      request.then(() => {
        throw new Error('Synthetic execution did not reach expected phase');
      }),
      deadline,
    ]);
  } finally {
    lifetime.abort();
  }
}

export async function cancelAfterBody(
  bodyRead: Promise<void>,
  request: Promise<unknown>,
  abort: AbortController,
  signal: AbortSignal,
) {
  const cancelled = request.then(
    () => false,
    (error: unknown) => abort.signal.aborted && error === abort.signal.reason,
  );
  let stoppedByAbort: boolean;
  try {
    await httpMultiPhase(bodyRead, cancelled, signal);
  } finally {
    abort.abort();
    stoppedByAbort = await cancelled;
  }
  assert.ok(
    stoppedByAbort,
    'The queued request must stop through its cancellation signal',
  );
}
