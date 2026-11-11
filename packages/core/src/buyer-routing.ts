// Buyer-local busy and replacement price policy; no I/O, signatures or implicit spending permission.
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import { controlObject } from '@gyblos/protocol/control-validation';
import { parseTokenPricesV2 } from '@gyblos/protocol/pricing-v2';

import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
  type BuyerBusyPolicy,
  type BuyerRoutingCode,
} from './constants';

export interface BuyerRoutingPolicy {
  onBusy: BuyerBusyPolicy;
  allowPinnedFallback: boolean;
  allowHigherPriceFallback: boolean;
}
export class BuyerRoutingError extends Error {
  constructor(readonly code: BuyerRoutingCode) {
    super(code);
    this.name = 'BuyerRoutingError';
  }
}
export function parseBuyerRoutingPolicy(value?: unknown): BuyerRoutingPolicy {
  try {
    const keys = ['onBusy', 'allowPinnedFallback', 'allowHigherPriceFallback'];
    const input = value === undefined ? {} : value;
    const row = controlObject(
      input,
      keys.filter(
        (key) =>
          input !== null &&
          typeof input === 'object' &&
          Object.hasOwn(input, key),
      ),
    );
    const onBusy =
      row.onBusy === undefined ? BUYER_BUSY_POLICIES.REROUTE : row.onBusy;
    if (!Object.values(BUYER_BUSY_POLICIES).some((choice) => choice === onBusy))
      throw new Error();
    for (const key of keys.slice(1))
      if (row[key] !== undefined && typeof row[key] !== 'boolean')
        throw new Error();
    return {
      onBusy:
        onBusy === BUYER_BUSY_POLICIES.REJECT
          ? BUYER_BUSY_POLICIES.REJECT
          : BUYER_BUSY_POLICIES.REROUTE,
      allowPinnedFallback: row.allowPinnedFallback === true,
      allowHigherPriceFallback: row.allowHigherPriceFallback === true,
    };
  } catch {
    throw new BuyerRoutingError(BUYER_ROUTING_CODES.INVALID);
  }
}
export function fallbackPriceCeilings(
  policy: BuyerRoutingPolicy,
  reference: TokenPricesV2 | undefined,
  ceiling: TokenPricesV2,
): TokenPricesV2 | undefined {
  if (!reference) return undefined;
  const previous = parseTokenPricesV2(reference);
  const limits = parseTokenPricesV2(ceiling);
  if (policy.allowHigherPriceFallback) return limits;
  return {
    inputAtomicPerMtok: String(
      BigInt(previous.inputAtomicPerMtok) < BigInt(limits.inputAtomicPerMtok)
        ? BigInt(previous.inputAtomicPerMtok)
        : BigInt(limits.inputAtomicPerMtok),
    ),
    outputAtomicPerMtok: String(
      BigInt(previous.outputAtomicPerMtok) < BigInt(limits.outputAtomicPerMtok)
        ? BigInt(previous.outputAtomicPerMtok)
        : BigInt(limits.outputAtomicPerMtok),
    ),
  };
}
