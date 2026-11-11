// Buyer-local busy and replacement price policy; no I/O, signatures or implicit spending permission.
import { BUYER_ROUTING_DEFAULTS } from '@gyblos/config/buyer-routing';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import {
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { parseTokenPricesV2 } from '@gyblos/protocol/pricing-v2';

import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
  type BuyerBusyPolicy,
  type BuyerRoutingCode,
} from './constants';

export interface BuyerRoutingPolicy {
  onBusy: BuyerBusyPolicy;
  queueWaitMs: number;
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
    const keys = [
      'onBusy',
      'allowPinnedFallback',
      'allowHigherPriceFallback',
      'queueWaitMs',
    ];
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
      row.onBusy === undefined
        ? BUYER_BUSY_POLICIES.REROUTE
        : Object.values(BUYER_BUSY_POLICIES).find(
            (choice) => choice === row.onBusy,
          );
    if (!onBusy) throw new BuyerRoutingError(BUYER_ROUTING_CODES.INVALID);
    for (const key of ['allowPinnedFallback', 'allowHigherPriceFallback'])
      if (row[key] !== undefined && typeof row[key] !== 'boolean')
        throw new BuyerRoutingError(BUYER_ROUTING_CODES.INVALID);
    return {
      onBusy,
      queueWaitMs: controlInteger(
        row.queueWaitMs === undefined
          ? BUYER_ROUTING_DEFAULTS.queueWaitMs
          : row.queueWaitMs,
        1,
        BUYER_ROUTING_DEFAULTS.maxQueueWaitMs,
      ),
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
