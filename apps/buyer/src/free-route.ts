// How one selection is set up: the policy for this request and route, and the sellers discovery confirms.
import { primaryRelayUrl } from '@gyblos/transport-iroh/endpoint';

import { discoverBuyerSellers, type DiscoverOptions } from './discovery';
import type { PreparedSelection } from './free-selection';
import type { BuyerSelectionConfig } from './selection-config';

// The sellers discovery confirms, configured and (open discovery, free path only, where `excluded` is
// passed) found only in the index; paid and session execution look sellers up in their configured list.
export async function withDiscovered(
  prepared: PreparedSelection,
  base: ReturnType<typeof routedPolicy>,
  options: DiscoverOptions,
  excluded: ReadonlySet<string> | undefined,
) {
  if (!base.discovery || !prepared.discovery) return base;
  const open = base.discovery.open && excluded;
  return discoverBuyerSellers(
    { ...base, discovery: base.discovery },
    prepared.discovery,
    { ...options, ...(open ? { openRelay: primaryRelayUrl(), excluded } : {}) },
  );
}

// The policy one selection runs on: this request, the sellers not excluded, and the route's pin and
// previous seller.
export function routedPolicy(
  policy: BuyerSelectionConfig,
  excluded: ReadonlySet<string>,
  request: BuyerSelectionConfig['request'],
  route?: SelectionRoute,
) {
  return {
    ...policy,
    ...(route && 'pinnedNodeId' in route
      ? { pinnedNodeId: route.pinnedNodeId }
      : {}),
    ...(route?.previousSeller ? { previousSeller: route.previousSeller } : {}),
    request,
    sellers: policy.sellers.filter((seller) => !excluded.has(seller.nodeId)),
  };
}
export interface SelectionRoute {
  pinnedNodeId?: string;
  waitingFor?: string;
  previousSeller?: string;
  // Free execution only: sellers found only in the index may be used.
  open?: true;
}
