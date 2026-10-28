// Owns the discovery error class: a static code and optional HTTP status, never request or response text.
// It must not know records, selection policy or UI wording.
import type { DiscoveryErrorCode } from './constants';

export class DiscoveryError extends Error {
  override readonly name = 'DiscoveryError';

  constructor(
    readonly code: DiscoveryErrorCode,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(code, options);
  }
}

export function discoveryFail(
  code: DiscoveryErrorCode,
  status?: number,
): never {
  throw new DiscoveryError(code, status);
}
