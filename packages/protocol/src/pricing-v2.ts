// Parses explicit per-million v2 prices; never accepts or converts per-token wire terms.
import { V2_PRICING } from './constants.js';
import type { PublicPricesV2, TokenPricesV2 } from './control-types.js';
import {
  controlAddress,
  controlAtomic,
  controlFail,
  controlNetwork,
  controlObject,
} from './control-validation.js';

export function parseTokenPricesV2(value: unknown): TokenPricesV2 {
  const prices = controlObject(value, [
    'inputAtomicPerMtok',
    'outputAtomicPerMtok',
  ]);
  return {
    inputAtomicPerMtok: controlAtomic(prices.inputAtomicPerMtok),
    outputAtomicPerMtok: controlAtomic(prices.outputAtomicPerMtok),
  };
}
export function parsePublicPricesV2(value: unknown): PublicPricesV2 {
  const prices = controlObject(value, [
    'network',
    'asset',
    'unit',
    'inputAtomicPerMtok',
    'outputAtomicPerMtok',
  ]);
  if (prices.unit !== V2_PRICING.unit) return controlFail();
  return {
    network: controlNetwork(prices.network),
    asset: controlAddress(prices.asset),
    unit: V2_PRICING.unit,
    ...parseTokenPricesV2({
      inputAtomicPerMtok: prices.inputAtomicPerMtok,
      outputAtomicPerMtok: prices.outputAtomicPerMtok,
    }),
  };
}
