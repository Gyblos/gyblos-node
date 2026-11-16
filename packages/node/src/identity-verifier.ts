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

import { BUYER_IDENTITY, IDENTITY_STATE } from './constants';
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
type Lookup = Awaited<ReturnType<typeof readRegistryIdentity>>;

export async function openBuyerIdentityVerifier(
  environment: HomeEnvironment,
  rpc: IdentityResolutionRpc | string,
  admission?: BuyerIdentityAdmission,
  options: { now?: () => number; freshLookupMs?: number } = {},
): Promise<BuyerIdentityVerifier> {
  const source =
    typeof rpc === 'string' ? createIdentityResolutionRpc(rpc) : rpc;
  const state = await openBuyerIdentityState(
    environment,
    IDENTITY_RESOLUTION_SCOPE,
    admission,
  );
  const now = options.now ?? Date.now;
  const freshMs = options.freshLookupMs ?? BUYER_IDENTITY.freshLookupMs;
  // Bound registry bindings read recently, per NodeId; only a lookup that admitted the seller is kept.
  const recent = new Map<string, { at: number; lookup: Lookup }>();
  const read = async (nodeId: string, signal?: AbortSignal) => {
    const kept = recent.get(nodeId);
    const age = kept ? now() - kept.at : Infinity;
    if (kept && age >= 0 && age < freshMs)
      return { lookup: kept.lookup, fresh: false };
    recent.delete(nodeId);
    return {
      lookup: await readRegistryIdentity(source, nodeId, { signal }),
      fresh: true,
    };
  };
  return {
    async verify(subject, signal) {
      signal?.throwIfAborted();
      const registry =
        subject.manualTrust === true
          ? undefined
          : await read(subject.nodeId, signal);
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
      if (registry?.fresh && lookup) {
        if (decision.ok && lookup.kind === IDENTITY_LOOKUP_KINDS.BOUND)
          recent.set(subject.nodeId, { at: now(), lookup });
        // Bounded like the durable identity rows; dropping entries only costs another registry read.
        if (recent.size > IDENTITY_STATE.maxRows) recent.clear();
      } else if (registry && !decision.ok) recent.delete(subject.nodeId);
      return decision;
    },
  };
}
