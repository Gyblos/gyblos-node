// The seller's public listing: what the daemon serves and its paid or free terms. No config loading here,
// so control startup and the lab host stay independent of gyblos.toml reading.
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

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

// What the daemon serves: the pinned Qwen3 0.6B with one reasoning level, free, on the seller's Ollama.
export const SERVED_OFFER = {
  modelId: MODEL_IDS.QWEN3_0_6B,
  reasoning: [REASONING_LEVELS.OFF] satisfies readonly ReasoningLevel[],
} as const;

// The only listing the seller daemon serves while paid selling is off (phase 2 brings it back as a plugin).
export type FreeSellerOffer = Extract<
  SellerCatalogOffer,
  { kind: typeof OFFER_PRICING_KINDS.FREE }
>;

// A free listing is zero on both sides, which is what quotes and selection key on.
export function listedPrices(offer: SellerCatalogOffer): TokenPricesV2 {
  return offer.kind === OFFER_PRICING_KINDS.FREE
    ? { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' }
    : offer.prices;
}
