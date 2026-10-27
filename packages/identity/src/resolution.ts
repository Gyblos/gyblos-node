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
import { assertIdentityReadActive } from './read.js';
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
  const queryNodeId =
    typeof nodeId === 'string' && isCanonicalNodeId(nodeId) ? nodeId : null;
  const unavailable = (
    reason: Extract<
      IdentityLookup,
      { kind: typeof IDENTITY_LOOKUP_KINDS.UNAVAILABLE }
    >['reason'],
  ): IdentityLookup => ({
    kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
    scope,
    nodeId: queryNodeId,
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
  const deadlineAt = performance.now() + timeout;
  const deadline = AbortSignal.timeout(timeout);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    deadline,
    lifetime.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const readOptions = {
    collection: DEVNET_REGISTRY.collection,
    commitment: FINALIZED_COMMITMENT,
    signal,
    deadline: deadlineAt,
  };
  try {
    const result = await bounded(async () => {
      assertIdentityReadActive(readOptions);
      const genesis = await rpc.getGenesisHash().send({ abortSignal: signal });
      assertIdentityReadActive(readOptions);
      if (genesis !== DEVNET_GENESIS)
        return unavailable(IDENTITY_LOOKUP_FAILURES.NETWORK);
      const binding = await resolveNodeBinding(rpc, nodeId, readOptions);
      assertIdentityReadActive(readOptions);
      return binding
        ? { kind: IDENTITY_LOOKUP_KINDS.BOUND, scope, nodeId, binding }
        : { kind: IDENTITY_LOOKUP_KINDS.MISSING, scope, nodeId };
    }, signal);
    assertIdentityReadActive(readOptions);
    return result;
  } catch (error) {
    if (options.signal?.aborted)
      return unavailable(IDENTITY_LOOKUP_FAILURES.CANCELLED);
    if (deadline.aborted) return unavailable(IDENTITY_LOOKUP_FAILURES.TIMEOUT);
    if (error instanceof IdentityError) {
      if (error.code === IDENTITY_ERROR_CODES.READ_TIMEOUT)
        return unavailable(IDENTITY_LOOKUP_FAILURES.TIMEOUT);
      if (error.code === IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS)
        return unavailable(IDENTITY_LOOKUP_FAILURES.AMBIGUOUS);
      if (error.code === IDENTITY_ERROR_CODES.TOO_MANY_CLAIMANTS)
        return unavailable(IDENTITY_LOOKUP_FAILURES.LIMIT);
    }
    return unavailable(IDENTITY_LOOKUP_FAILURES.UNAVAILABLE);
  } finally {
    lifetime.abort();
  }
}
