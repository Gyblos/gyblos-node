// Bounds acceptance phase barriers; request cancellation and early completion must reach cleanup.
import assert from 'node:assert/strict';
import timers from 'node:timers/promises';

import { HTTP_MULTI } from './http-multiseller-constants';
import { NativeTestDeadlineError } from './test-deadline';

async function withDeadline<T>(
  run: (deadline: Promise<never>) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const lifetime = new AbortController();
  const deadline = timers
    .setTimeout(HTTP_MULTI.operationMs, undefined, {
      signal: AbortSignal.any([signal, lifetime.signal]),
    })
    .then(() => {
      throw new NativeTestDeadlineError();
    });
  try {
    return await run(deadline);
  } finally {
    lifetime.abort();
  }
}

function expectPhase<T>(
  phase: Promise<T>,
  request: Promise<unknown>,
  deadline: Promise<never>,
) {
  return Promise.race([
    phase,
    request.then(() => {
      throw new Error('Synthetic execution did not reach expected phase');
    }),
    deadline,
  ]);
}

export function httpMultiPhase<T>(
  phase: Promise<T>,
  request: Promise<unknown>,
  signal: AbortSignal,
): Promise<T> {
  return withDeadline(
    (deadline) => expectPhase(phase, request, deadline),
    signal,
  );
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
  await withDeadline(async (deadline) => {
    try {
      await expectPhase(bodyRead, cancelled, deadline);
    } finally {
      abort.abort();
    }
    assert.ok(
      await Promise.race([cancelled, deadline]),
      'The queued request must stop through its cancellation signal',
    );
  }, signal);
}
