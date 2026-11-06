// Creates separate read-only and registration Solana RPC ports with bounded decoded responses.
// SDK method/BigInt transforms remain intact; strict registry account validation still owns trust.
import {
  createSolanaRpcFromTransport,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import {
  parseJsonWithBigInts,
  stringifyJsonWithBigInts,
} from '@solana/rpc-spec-types';

import {
  IDENTITY_ERROR_CODES,
  IDENTITY_REGISTRATION_RPC_METHODS,
  IDENTITY_RPC_METHODS,
} from './constants';
import { identityRpcFail } from './errors';
import type { IdentityResolutionRpc } from './resolution';
import { readIdentityRpcResponse } from './resolution-rpc-http';
import {
  identityRpcOptions,
  type IdentityRpcOptions,
} from './resolution-rpc-options';

export type {
  IdentityRpcFetch,
  IdentityRpcOptions,
} from './resolution-rpc-options';
function requestId(payload: unknown, methods: readonly string[]) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('id' in payload) ||
    typeof payload.id !== 'string' ||
    !('jsonrpc' in payload) ||
    payload.jsonrpc !== '2.0' ||
    !('method' in payload) ||
    !methods.some((method) => method === payload.method)
  )
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_REQUEST_INVALID);
  return payload.id;
}
function envelope(text: string, id: string): unknown {
  let value: unknown;
  try {
    value = parseJsonWithBigInts(text);
  } catch {
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_INVALID);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('jsonrpc' in value) ||
    value.jsonrpc !== '2.0' ||
    !('id' in value) ||
    value.id !== id ||
    Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')
  )
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_INVALID);
  if (Object.hasOwn(value, 'error'))
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_TRANSPORT_FAILED);
  return value;
}
function identityRpc(
  url: string,
  options: IdentityRpcOptions,
  methods: readonly string[],
): Rpc<SolanaRpcApi> {
  const config = identityRpcOptions(url, options);
  // The SDK transport signature is generic; the implementation hands unknown JSON to its
  // response transformers. This overload does not assert that arbitrary account data is valid.
  function transport<TResponse>(
    request: Parameters<RpcTransport>[0],
  ): Promise<TResponse>;
  async function transport({
    payload,
    signal,
  }: Parameters<RpcTransport>[0]): Promise<unknown> {
    const id = requestId(payload, methods);
    return readIdentityRpcResponse(
      config,
      stringifyJsonWithBigInts(payload),
      signal,
      (text) => envelope(text, id),
    );
  }
  return createSolanaRpcFromTransport(transport);
}

// Registry verification keeps its original read-only method allowlist.
export function createIdentityResolutionRpc(
  url: string,
  options: IdentityRpcOptions = {},
): IdentityResolutionRpc {
  return identityRpc(url, options, IDENTITY_RPC_METHODS);
}
// Seller registration uses the same response cap with a separate, narrow write allowlist.
export function createIdentityRegistrationRpc(
  url: string,
  options: IdentityRpcOptions = {},
): Rpc<SolanaRpcApi> {
  return identityRpc(url, options, IDENTITY_REGISTRATION_RPC_METHODS);
}
