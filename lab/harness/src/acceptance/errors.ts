// Static acceptance failures; never includes input, engine errors, identity material or local paths.
import { ACCEPTANCE_CODES, type AcceptanceCode } from './constants';

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

// Error metadata is untrusted even when the prototype is familiar; never invoke accessors.
export function acceptanceDiagnosticCode(error: unknown) {
  try {
    if (error instanceof AcceptanceError) {
      const value: unknown = Object.getOwnPropertyDescriptor(
        error,
        'code',
      )?.value;
      return (
        Object.values(ACCEPTANCE_CODES).find((code) => code === value) ??
        ACCEPTANCE_CODES.FAILED
      );
    }
  } catch {
    /* Hostile thrown values remain unknown. */
  }
  return ACCEPTANCE_CODES.FAILED;
}
