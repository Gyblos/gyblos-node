// Owns the identity error class carrying a code from IDENTITY_ERROR_CODES.
// It must not know RPC transports, policy storage or UI wording.
import type { IdentityErrorCode } from './constants.js';

export class IdentityError extends Error {
  override readonly name = 'IdentityError';

  constructor(
    readonly code: IdentityErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// New read-only transport errors are static and never retain URLs, bodies or remote causes.
export function identityRpcFail(code: IdentityErrorCode): never {
  throw new IdentityError(code, code);
}
