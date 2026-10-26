// Read-only 8004 boundary: pinned devnet registry, finalized account reads and bounded cancellation.
// It never constructs/signs transactions, reads files, caches trust or treats an outage as missing identity.
import type { Rpc, SolanaRpcApi } from '@solana/kit';

import { DEVNET, DEVNET_GENESIS, FINALIZED_COMMITMENT } from '@gyblos/config';
import {
  IDENTITY_LOOKUP_FAILURES,
  IDENTITY_LOOKUP_KINDS,
  type IdentityLookup,
  type IdentityRegistryScope,
} from '@gyblos/core/identity-policy';

import { isCanonicalNodeId } from './binding.js';
import {
  DEVNET_REGISTRY,
  IDENTITY_ERROR_CODES,
  IDENTITY_RESOLUTION_LIMITS,
  PROGRAMS,
} from './constants.js';
import { IdentityError } from './errors.js';
import { resolveNodeBinding } from './resolve.js';

export type IdentityResolutionRpc = Pick<
  Rpc<SolanaRpcApi>,
  'getGenesisHash' | 'getProgramAccounts' | 'getMultipleAccounts'
>;
export interface IdentityResolutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export const IDENTITY_RESOLUTION_SCOPE: Readonly<IdentityRegistryScope> = {
  network: DEVNET,
  program: PROGRAMS.registry,
  collection: DEVNET_REGISTRY.collection,
};
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export async function readRegistryIdentity(
  rpc: IdentityResolutionRpc,
  nodeId: unknown,
  options: IdentityResolutionOptions = {},
): Promise<IdentityLookup> {
  const scope = { ...IDENTITY_RESOLUTION_SCOPE };
  const unavailable = (
    reason: Extract<
      IdentityLookup,
      { kind: typeof IDENTITY_LOOKUP_KINDS.UNAVAILABLE }
    >['reason'],
  ): IdentityLookup => ({
    kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
    scope,
    reason,
  });
  const timeout = options.timeoutMs ?? IDENTITY_RESOLUTION_LIMITS.timeoutMs;
  if (
    typeof nodeId !== 'string' ||
    !isCanonicalNodeId(nodeId) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > IDENTITY_RESOLUTION_LIMITS.maxTimeoutMs
  )
    return unavailable(IDENTITY_LOOKUP_FAILURES.INVALID);
  const deadline = AbortSignal.timeout(timeout);
  const signal = AbortSignal.any([
    deadline,
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    return await bounded(async () => {
      const genesis = await rpc.getGenesisHash().send({ abortSignal: signal });
      signal.throwIfAborted();
      if (genesis !== DEVNET_GENESIS)
        return unavailable(IDENTITY_LOOKUP_FAILURES.NETWORK);
      const binding = await resolveNodeBinding(rpc, nodeId, {
        collection: DEVNET_REGISTRY.collection,
        commitment: FINALIZED_COMMITMENT,
        signal,
      });
      signal.throwIfAborted();
      return binding
        ? { kind: IDENTITY_LOOKUP_KINDS.BOUND, scope, binding }
        : { kind: IDENTITY_LOOKUP_KINDS.MISSING, scope };
    }, signal);
  } catch (error) {
    if (options.signal?.aborted)
      return unavailable(IDENTITY_LOOKUP_FAILURES.CANCELLED);
    if (deadline.aborted) return unavailable(IDENTITY_LOOKUP_FAILURES.TIMEOUT);
    if (error instanceof IdentityError) {
      if (error.code === IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS)
        return unavailable(IDENTITY_LOOKUP_FAILURES.AMBIGUOUS);
      if (error.code === IDENTITY_ERROR_CODES.TOO_MANY_CLAIMANTS)
        return unavailable(IDENTITY_LOOKUP_FAILURES.LIMIT);
    }
    return unavailable(IDENTITY_LOOKUP_FAILURES.UNAVAILABLE);
  }
}
