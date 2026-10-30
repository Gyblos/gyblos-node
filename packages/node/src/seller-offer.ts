// The seller's public listing: what the daemon serves and its paid or free terms. No config loading here,
// so control startup and the lab host stay independent of gyblos.toml reading.
import { PROTOCOL_FEE } from '@gyblos/config';
import {
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import { grossAtomicPerMtok } from '@gyblos/protocol/payment-binding';

import type { OfferModel } from './node-config';

// Token caps from gyblos.toml `free = {...}`; the free execution handler enforces them.
export interface FreeOfferCaps {
  // Total tokens this offer gives away per day, across all buyers.
  dailyTokenCap: number;
  // Tokens per buyer NodeId per day; best effort, since NodeIds are free to create.
  perBuyerCap: number;
}

export type SellerCatalogOffer = {
  // The catalog model id the offer's engine plugin serves.
  modelId: string;
  reasoning: readonly ReasoningLevel[];
  // A paid offer's prices are the seller's own; buyers pay them plus the protocol fee (listedPrices).
} & (
  | { kind: typeof OFFER_PRICING_KINDS.PAID; prices: TokenPricesV2 }
  | { kind: typeof OFFER_PRICING_KINDS.FREE; caps: FreeOfferCaps }
);

// The pinned Qwen3 0.6B with one reasoning level on the seller's Ollama; its public tokenizer is what
// makes an offer recountable, which paid offers require.
export const SERVED_OFFER = {
  modelId: MODEL_IDS.QWEN3_0_6B,
  reasoning: [REASONING_LEVELS.OFF] satisfies readonly ReasoningLevel[],
} as const;

// The served model's public tokenizer is pinned, so its usage is recounted whatever engine serves it.
export function recountsWithPinnedTokenizer(model: OfferModel) {
  return (
    model.kind === MODEL_CLASSIFICATIONS.CATALOG &&
    model.id === SERVED_OFFER.modelId
  );
}

export type FreeSellerOffer = Extract<
  SellerCatalogOffer,
  { kind: typeof OFFER_PRICING_KINDS.FREE }
>;
export type PaidSellerOffer = Extract<
  SellerCatalogOffer,
  { kind: typeof OFFER_PRICING_KINDS.PAID }
>;

// What buyers see and pay: zero on both sides for a free listing; for a paid one, the seller's price
// plus the protocol fee, rounded up, which quotes, ceilings and charges all use.
export function listedPrices(
  offer: SellerCatalogOffer,
  protocolFeeBps: number = PROTOCOL_FEE.bps,
): TokenPricesV2 {
  if (offer.kind === OFFER_PRICING_KINDS.FREE)
    return { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' };
  return {
    inputAtomicPerMtok: grossAtomicPerMtok(
      offer.prices.inputAtomicPerMtok,
      protocolFeeBps,
    ),
    outputAtomicPerMtok: grossAtomicPerMtok(
      offer.prices.outputAtomicPerMtok,
      protocolFeeBps,
    ),
  };
}
