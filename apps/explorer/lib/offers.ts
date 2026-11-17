// Owns the summary of the offers in the discovery index: free vs paid offers, the average 24 h
// uptime, and per model the sellers, free offers, cheapest paid prices and largest context.
import { DISPLAY } from './constants';
import type { DiscoverySnapshot, OfferedModel, Seller } from './discovery';

export interface ModelOffers {
  sellers: number;
  free: number;
  minInput: bigint | null;
  minOutput: bigint | null;
  context: number;
}
const isFree = (model: OfferedModel) =>
  model.pricing.inputAtomicPerMtok === '0' &&
  model.pricing.outputAtomicPerMtok === '0';
const lowest = (current: bigint | null, value: bigint) =>
  current === null || value < current ? value : current;

export const uptimeRatio = (seller: Seller, days: number) =>
  seller.uptime?.windows.find((window) => window.days === days)?.ratio;

export function summarizeOffers(snapshot: DiscoverySnapshot) {
  const offers = snapshot.sellers.flatMap((seller) => seller.models);
  const day = snapshot.sellers
    .map((seller) => uptimeRatio(seller, DISPLAY.dayWindow))
    .filter((ratio): ratio is number => typeof ratio === 'number');
  const models = new Map<string, ModelOffers>();
  for (const offer of offers) {
    const key = [offer.modelId, offer.variant, offer.quantization]
      .filter(Boolean)
      .join(' ');
    const entry = models.get(key) ?? {
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
    averageDayUptime: day.length
      ? day.reduce((sum, ratio) => sum + ratio, 0) / day.length
      : null,
    models,
  };
}
