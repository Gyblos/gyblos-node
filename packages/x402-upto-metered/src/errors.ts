// Owns the package's only error type; the message is the static code, so
// RPC URLs, keys and upstream text never leave through an error.
import { UPTO_ERROR_CODES, type UptoErrorCode } from './constants';

export class UptoError extends Error {
  constructor(readonly code: UptoErrorCode) {
    super(code);
    this.name = 'UptoError';
  }
}

// Keeps package errors as they are and turns anything else into INTERNAL.
export function uptoError(error: unknown): UptoError {
  return error instanceof UptoError
    ? error
    : new UptoError(UPTO_ERROR_CODES.INTERNAL);
}
