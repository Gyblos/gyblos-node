// Owns the summary of the offers in the discovery index: free vs paid offers, the average 24 h
// uptime, and per model the sellers, free offers, cheapest paid prices and largest context.
import type { DiscoverySnapshot, OfferedModel, Seller } from './discovery';

export interface ModelOffers {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  sellers: number;
  free: number;
  minInput: bigint | null;
  minOutput: bigint | null;
  context: number;
}
// A model's identity as published: the same id with another variant or quantization is another model.
export const modelKey = (model: {
  modelId: string;
  variant: string | null;
  quantization: string | null;
}) => JSON.stringify([model.modelId, model.variant, model.quantization]);
const isFree = (model: OfferedModel) =>
  model.pricing.inputAtomicPerMtok === '0' &&
  model.pricing.outputAtomicPerMtok === '0';
const lowest = (current: bigint | null, value: bigint) =>
  current === null || value < current ? value : current;

export const uptimeRatio = (seller: Seller, days: number) =>
  seller.uptime?.windows.find((window) => window.days === days)?.ratio;

export function summarizeOffers(snapshot: DiscoverySnapshot) {
  const offers = snapshot.sellers.flatMap((seller) => seller.models);
  const models = new Map<string, ModelOffers>();
  for (const offer of offers) {
    const key = modelKey(offer);
    const entry = models.get(key) ?? {
      modelId: offer.modelId,
      variant: offer.variant,
      quantization: offer.quantization,
      sellers: 0,
      free: 0,
      minInput: null,
      minOutput: null,
      context: 0,
    };
    entry.sellers += 1;
    if (isFree(offer)) entry.free += 1;
    else {
      entry.minInput = lowest(
        entry.minInput,
        BigInt(offer.pricing.inputAtomicPerMtok),
      );
      entry.minOutput = lowest(
        entry.minOutput,
        BigInt(offer.pricing.outputAtomicPerMtok),
      );
    }
    entry.context = Math.max(entry.context, offer.contextTokens);
    models.set(key, entry);
  }
  return {
    offers: offers.length,
    free: offers.filter(isFree).length,
    // Models with at least one free offer now.
    freeModels: [...models.values()].filter((model) => model.free > 0).length,
    // The network's lowest paid prices per million tokens, each over every model; null without paid offers.
    minInput: [...models.values()].reduce<bigint | null>(
      (low, model) =>
        model.minInput === null ? low : lowest(low, model.minInput),
      null,
    ),
    minOutput: [...models.values()].reduce<bigint | null>(
      (low, model) =>
        model.minOutput === null ? low : lowest(low, model.minOutput),
      null,
    ),
    models,
  };
}
