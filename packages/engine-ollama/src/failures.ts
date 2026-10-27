// Maps Ollama HTTP, timeout and stream failures to the uniform EngineError catalog in a fixed precedence.
// Errors never carry upstream bodies, headers or text; callers' own aborts and callback errors pass through.
import { HTTP_STATUS } from '@gyblos/config';
import {
  ENGINE_ERROR_CODES,
  type EngineErrorCode,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';

// A malformed generation frame; `upstream` marks an explicit error frame from Ollama.
export class FrameFailure extends Error {
  constructor(readonly upstream = false) {
    super('Invalid engine frame.');
    this.name = 'FrameFailure';
  }
}
// A frame or the total output exceeded a hard bound, whether or not text was delivered.
export class BoundFailure extends Error {
  constructor() {
    super('Engine output exceeds limit.');
    this.name = 'BoundFailure';
  }
}

const STATUS_CODES: Readonly<Partial<Record<number, EngineErrorCode>>> = {
  [HTTP_STATUS.unauthorized]: ENGINE_ERROR_CODES.AUTH,
  [HTTP_STATUS.forbidden]: ENGINE_ERROR_CODES.AUTH,
  [HTTP_STATUS.paymentRequired]: ENGINE_ERROR_CODES.QUOTA_EXHAUSTED,
  [HTTP_STATUS.tooManyRequests]: ENGINE_ERROR_CODES.RATE_LIMITED,
};
export function statusFailure(status: number) {
  return new EngineError(
    STATUS_CODES[status] ?? ENGINE_ERROR_CODES.UNAVAILABLE,
  );
}

// What one engine call has observed so far, so a failure can be classified once.
export interface EngineAttempt {
  caller?: AbortSignal;
  deadline: AbortSignal;
  fragments: number;
  callback?: { error: unknown };
}

export function engineFailure(error: unknown, attempt: EngineAttempt): unknown {
  if (attempt.caller?.aborted) return attempt.caller.reason;
  if (attempt.callback) return attempt.callback.error;
  if (attempt.deadline.aborted)
    return new EngineError(ENGINE_ERROR_CODES.TIMEOUT);
  if (error instanceof EngineError) return error;
  if (error instanceof BoundFailure)
    return new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  if (attempt.fragments > 0)
    return new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
  if (error instanceof FrameFailure)
    return new EngineError(
      error.upstream
        ? ENGINE_ERROR_CODES.UNAVAILABLE
        : ENGINE_ERROR_CODES.INVALID_RESPONSE,
    );
  // A rejected connection or body read before any text.
  return new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
}

// Runs a caller callback and remembers its failure so it propagates unchanged.
export async function callerCallback(
  attempt: EngineAttempt,
  run: (() => Promise<void>) | undefined,
) {
  if (!run) return;
  try {
    await run();
  } catch (error) {
    attempt.callback = { error };
    throw error;
  }
}
