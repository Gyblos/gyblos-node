// The seller's public listing: what the daemon serves and its paid or free terms. No config loading here,
// so control startup and the lab host stay independent of gyblos.toml reading.
import { HOSTS } from '@gyblos/config';
import { PRICES } from '@gyblos/core/constants';
import { atomicPerTokenPricesV2 } from '@gyblos/core/pricing-v2';
import {
  MODEL_IDS,
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import { OFFER_PRICING_KINDS } from './constants';

// Token caps from gyblos.toml `free = {...}`; the free execution handler enforces them.
export interface FreeOfferCaps {
  // Total tokens this offer gives away per day, across all buyers.
  dailyTokenCap: number;
  // Tokens per buyer NodeId per day; best effort, since NodeIds are free to create.
  perBuyerCap: number;
}

export type SellerCatalogOffer = {
  modelId: typeof MODEL_IDS.QWEN3_0_6B;
  reasoning: readonly ReasoningLevel[];
} & (
  | { kind: typeof OFFER_PRICING_KINDS.PAID; prices: TokenPricesV2 }
  | { kind: typeof OFFER_PRICING_KINDS.FREE; caps: FreeOfferCaps }
);

// What the daemon actually runs: its managed Ollama, the pinned Qwen3 0.6B and one reasoning level.
export const SERVED_OFFER = {
  modelId: MODEL_IDS.QWEN3_0_6B,
  engineUrl: HOSTS.ollama,
  reasoning: [REASONING_LEVELS.OFF] satisfies readonly ReasoningLevel[],
} as const;

// Paid execution is the v1 PoC, so a paid listing advertises exactly its rates per million tokens.
export const servedPaidPrices = () => atomicPerTokenPricesV2(PRICES);

// Today's listing when gyblos.toml has no offers.
export function defaultSellerOffer(): SellerCatalogOffer {
  return {
    modelId: SERVED_OFFER.modelId,
    reasoning: [...SERVED_OFFER.reasoning],
    kind: OFFER_PRICING_KINDS.PAID,
    prices: servedPaidPrices(),
  };
}

// A free listing is zero on both sides, which is what quotes and selection key on.
export function listedPrices(offer: SellerCatalogOffer): TokenPricesV2 {
  return offer.kind === OFFER_PRICING_KINDS.FREE
    ? { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' }
    : offer.prices;
}
