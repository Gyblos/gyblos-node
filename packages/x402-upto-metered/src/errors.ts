// Owns the package's only error type; the message is the static code, so
// RPC URLs, keys and upstream text never leave through an error.
import { UPTO_ERROR_CODES, type UptoErrorCode } from './constants';

const KNOWN_CODES: ReadonlySet<string> = new Set(
  Object.values(UPTO_ERROR_CODES),
);

function knownCode(code: unknown): UptoErrorCode {
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? (code as UptoErrorCode)
    : UPTO_ERROR_CODES.INTERNAL;
}

export class UptoError extends Error {
  readonly code: UptoErrorCode;

  // Untyped callers cannot smuggle text in: an unknown code becomes INTERNAL.
  constructor(code: UptoErrorCode) {
    const known = knownCode(code);
    super(known);
    this.code = known;
    this.name = 'UptoError';
  }
}

// Always returns a fresh error built from a known code, so a subclass or an
// error whose message was rewritten after construction never passes through.
export function uptoError(error: unknown): UptoError {
  return new UptoError(
    error instanceof UptoError
      ? knownCode(error.code)
      : UPTO_ERROR_CODES.INTERNAL,
  );
}
