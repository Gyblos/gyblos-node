import { EndpointAddr, EndpointId } from '@number0/iroh';

import {
  assertConfiguredRelay,
  primaryRelayUrl,
} from '@gyblos/transport-iroh/endpoint';

import type { StaticControlSeller } from './selection-config';

export function restoredSellerAddress(
  nodeId: string,
  owner: string,
  relayOnly: boolean,
) {
  return sellerAddress(
    { nodeId, owner, relayUrl: primaryRelayUrl(), directAddresses: [] },
    relayOnly,
  );
}
export function sellerAddress(seller: StaticControlSeller, relayOnly: boolean) {
  if (seller.relayUrl) assertConfiguredRelay(seller.relayUrl);
  return new EndpointAddr(
    EndpointId.fromString(seller.nodeId),
    seller.relayUrl ?? undefined,
    relayOnly ? [] : seller.directAddresses,
  );
}
