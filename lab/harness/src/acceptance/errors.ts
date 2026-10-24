// Static acceptance failures; never includes input, engine errors, identity material or local paths.
import { ACCEPTANCE_CODES, type AcceptanceCode } from './constants.js';

export class AcceptanceError extends Error {
  constructor(readonly code: AcceptanceCode) {
    super(code);
    this.name = 'AcceptanceError';
  }
}
export function acceptanceAssert(condition: unknown): asserts condition {
  if (!condition) throw new AcceptanceError(ACCEPTANCE_CODES.FAILED);
}
export function assertAcceptanceActive(signal: AbortSignal) {
  if (signal.aborted) throw new AcceptanceError(ACCEPTANCE_CODES.CANCELLED);
}
