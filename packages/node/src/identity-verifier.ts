// Composes independent read-only registry observations with durable buyer trust policy.
// Manual pins are explicit; an outage never supplies fallback trust, and no payment SDK is called.
import type { HomeEnvironment } from '@gyblos/config/home';
import type { IdentityPolicyDecision } from '@gyblos/core/identity-policy';
import {
  IDENTITY_RESOLUTION_SCOPE,
  readRegistryIdentity,
  type IdentityResolutionRpc,
} from '@gyblos/identity/resolution';
import { createIdentityResolutionRpc } from '@gyblos/identity/resolution-rpc';

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
): Promise<BuyerIdentityVerifier> {
  const source =
    typeof rpc === 'string' ? createIdentityResolutionRpc(rpc) : rpc;
  const state = await openBuyerIdentityState(
    environment,
    IDENTITY_RESOLUTION_SCOPE,
    admission,
  );
  return {
    async verify(subject, signal) {
      signal?.throwIfAborted();
      const lookup =
        subject.manualTrust === true
          ? undefined
          : await readRegistryIdentity(source, subject.nodeId, { signal });
      signal?.throwIfAborted();
      const decision = await state.evaluate({
        nodeId: subject.nodeId,
        owner: subject.owner,
        ...(subject.manualTrust === true
          ? { manual: { nodeId: subject.nodeId, owner: subject.owner } }
          : { lookup }),
      });
      signal?.throwIfAborted();
      return decision;
    },
  };
}
