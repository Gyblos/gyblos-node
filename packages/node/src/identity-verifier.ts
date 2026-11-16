// Composes independent read-only registry observations with durable buyer trust policy.
// Manual pins are explicit; an outage never supplies fallback trust beyond the reuse of a binding read
// within BUYER_IDENTITY.freshLookupMs, and no payment SDK is called.
import type { HomeEnvironment } from '@gyblos/config/home';
import { IDENTITY_LOOKUP_KINDS } from '@gyblos/core/constants';
import type { IdentityPolicyDecision } from '@gyblos/core/identity-policy';
import {
  IDENTITY_RESOLUTION_SCOPE,
  readRegistryIdentity,
  type IdentityResolutionRpc,
} from '@gyblos/identity/resolution';
import { createIdentityResolutionRpc } from '@gyblos/identity/resolution-rpc';

import { identityReuse, type IdentityReuseOptions } from './identity-reuse';
import { openBuyerIdentityState } from './identity-state';
import type { BuyerIdentityAdmission } from './identity-state-admission';

export interface BuyerIdentitySubject {
  nodeId: string;
  owner: string;
  manualTrust?: boolean;
}
export interface BuyerIdentityVerifier {
  verify(
    subject: BuyerIdentitySubject,
    signal?: AbortSignal,
  ): Promise<IdentityPolicyDecision>;
}
export async function openBuyerIdentityVerifier(
  environment: HomeEnvironment,
  rpc: IdentityResolutionRpc | string,
  admission?: BuyerIdentityAdmission,
  options: IdentityReuseOptions = {},
): Promise<BuyerIdentityVerifier> {
  const reuse = identityReuse(options);
  const source =
    typeof rpc === 'string' ? createIdentityResolutionRpc(rpc) : rpc;
  const state = await openBuyerIdentityState(
    environment,
    IDENTITY_RESOLUTION_SCOPE,
    admission,
  );
  const read = async (nodeId: string, signal?: AbortSignal, force = false) => {
    const kept = force ? undefined : reuse.get(nodeId);
    if (kept) return { lookup: kept.lookup, fresh: false, at: kept.at };
    reuse.drop(nodeId);
    const lookup = await readRegistryIdentity(source, nodeId, { signal });
    return { lookup, fresh: true, at: reuse.time() };
  };
  async function verify(
    subject: BuyerIdentitySubject,
    signal?: AbortSignal,
    force = false,
  ): Promise<IdentityPolicyDecision> {
    signal?.throwIfAborted();
    const registry =
      subject.manualTrust === true
        ? undefined
        : await read(subject.nodeId, signal, force);
    const lookup = registry?.lookup;
    signal?.throwIfAborted();
    const decision = await state.evaluate({
      nodeId: subject.nodeId,
      owner: subject.owner,
      ...(subject.manualTrust === true
        ? { manual: { nodeId: subject.nodeId, owner: subject.owner } }
        : { lookup }),
    });
    signal?.throwIfAborted();
    if (registry && !registry.fresh && !reuse.fresh(registry.at)) {
      reuse.drop(subject.nodeId);
      return verify(subject, signal, true);
    }
    if (registry?.fresh && lookup) {
      if (decision.ok && lookup.kind === IDENTITY_LOOKUP_KINDS.BOUND)
        reuse.keep(subject.nodeId, lookup, registry.at);
    } else if (registry && !decision.ok) reuse.drop(subject.nodeId);
    return decision;
  }
  return { verify: (subject, signal) => verify(subject, signal) };
}
