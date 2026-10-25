// Calculates bounded per-million v2 charges with one ceiling over the complete weighted usage.
// Does not authorize or execute payments, and never changes legacy per-token metering.
import {
  CONTROL_CODES,
  PUBLIC_RECORD_LIMITS,
  V2_PRICING,
} from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import {
  controlAtomic,
  controlFail,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { parseTokenPricesV2 } from '@gyblos/protocol/pricing-v2';

function boundedAmount(value: bigint): bigint {
  if (value > BigInt(PUBLIC_RECORD_LIMITS.maxAtomic))
    return controlFail(CONTROL_CODES.LIMIT);
  return value;
}
export function chargeV2(counts: unknown, rates: unknown): bigint {
  const usage = controlObject(counts, ['input', 'output']);
  const input = controlInteger(
    usage.input,
    0,
    PUBLIC_RECORD_LIMITS.maxContextTokens,
  );
  const output = controlInteger(
    usage.output,
    0,
    PUBLIC_RECORD_LIMITS.maxContextTokens,
  );
  const prices = parseTokenPricesV2(rates);
  const weighted =
    BigInt(input) * BigInt(prices.inputAtomicPerMtok) +
    BigInt(output) * BigInt(prices.outputAtomicPerMtok);
  const denominator = BigInt(V2_PRICING.tokensPerUnit);
  return boundedAmount((weighted + denominator - 1n) / denominator);
}
// Advertises the existing fixed v1 price exactly in v2 units; not an offer/payment conversion.
export function atomicPerTokenPricesV2(value: unknown): TokenPricesV2 {
  const prices = controlObject(value, ['inputAtomic', 'outputAtomic']);
  const scale = BigInt(V2_PRICING.tokensPerUnit);
  return {
    inputAtomicPerMtok: boundedAmount(
      BigInt(controlAtomic(prices.inputAtomic)) * scale,
    ).toString(),
    outputAtomicPerMtok: boundedAmount(
      BigInt(controlAtomic(prices.outputAtomic)) * scale,
    ).toString(),
  };
}
