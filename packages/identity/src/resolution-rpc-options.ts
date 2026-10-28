// Owns bounded read-only RPC configuration; no fetch or SDK initialization occurs on import.
import { LOOPBACK_HOST_NAMES } from '@gyblos/config';

import {
  IDENTITY_ERROR_CODES,
  IDENTITY_RESOLUTION_LIMITS,
  IDENTITY_RPC_LIMITS,
} from './constants';
import { identityRpcFail } from './errors';

export type IdentityRpcFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export interface IdentityRpcOptions {
  fetch?: IdentityRpcFetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
}
export function identityRpcOptions(url: string, options: IdentityRpcOptions) {
  try {
    const target = new URL(url);
    if (
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      (target.protocol !== 'https:' &&
        !(
          target.protocol === 'http:' &&
          LOOPBACK_HOST_NAMES.some((host) => host === target.hostname)
        ))
    )
      return identityRpcFail(IDENTITY_ERROR_CODES.RPC_REQUEST_INVALID);
    const maxResponseBytes =
      options.maxResponseBytes ?? IDENTITY_RPC_LIMITS.maxResponseBytes;
    const timeoutMs = options.timeoutMs ?? IDENTITY_RESOLUTION_LIMITS.timeoutMs;
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > IDENTITY_RPC_LIMITS.maxResponseBytes ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > IDENTITY_RESOLUTION_LIMITS.maxTimeoutMs ||
      (options.fetch !== undefined && typeof options.fetch !== 'function')
    )
      return identityRpcFail(IDENTITY_ERROR_CODES.RPC_REQUEST_INVALID);
    return {
      url: target.href,
      maxResponseBytes,
      timeoutMs,
      fetch: options.fetch ?? globalThis.fetch,
    };
  } catch {
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_REQUEST_INVALID);
  }
}
export type IdentityRpcConfig = ReturnType<typeof identityRpcOptions>;
