// Buyer-local busy and replacement price policy; no I/O, signatures or implicit spending permission.
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import { BUYER_BUSY_POLICIES, type BuyerBusyPolicy } from './constants';

export interface BuyerRoutingPolicy {
  onBusy: BuyerBusyPolicy;
  allowPinnedFallback: boolean;
  allowHigherPriceFallback: boolean;
}
export function parseBuyerRoutingPolicy(_value?: unknown): BuyerRoutingPolicy {
  return { onBusy: BUYER_BUSY_POLICIES.REROUTE, allowPinnedFallback: false, allowHigherPriceFallback: false };
}
export function fallbackPriceCeilings(
  _policy: BuyerRoutingPolicy,
  _reference: TokenPricesV2 | undefined,
  _ceiling: TokenPricesV2,
): TokenPricesV2 | undefined {
  return undefined;
}
