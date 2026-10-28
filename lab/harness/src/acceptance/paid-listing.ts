// The v1 proof-of-concept paid listing at its fixed rates per million tokens. Paid acceptance still quotes it;
// the seller daemon never serves it, since paid selling is off until it returns as a plugin.
import { PRICES } from '@gyblos/core/constants';
import { atomicPerTokenPricesV2 } from '@gyblos/core/pricing-v2';
import type { SellerCatalogOffer } from '@gyblos/node/seller-offer';
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

export function pocPaidListing(): SellerCatalogOffer {
  return {
    modelId: MODEL_IDS.QWEN3_0_6B,
    reasoning: [REASONING_LEVELS.OFF],
    kind: OFFER_PRICING_KINDS.PAID,
    prices: atomicPerTokenPricesV2(PRICES),
  };
}
