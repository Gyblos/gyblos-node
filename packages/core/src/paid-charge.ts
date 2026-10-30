// Prices a paid execution from recounted tokens at the quote's prices, and bounds the output the
// deposited ceiling can still pay for. The quote's prices are what the buyer pays, protocol fee
// included. Pure arithmetic; no engines, tokenizers, payment adapters or clocks.
import { V2_PRICING } from '@gyblos/protocol/constants';
import type {
  PaidCharge,
  PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';

import { chargeV2 } from './pricing-v2';

export interface PaidUsage {
  inputTokens: number;
  outputTokens: number;
}

function count(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Token counts must be whole non-negative numbers.');
  return BigInt(value);
}

// Most output tokens the ceiling still pays for after this input, within the requested tokens and
// the model context. Null when the input with a single output token already costs more than the
// ceiling or fills the context: then nothing should be deposited.
export function paidOutputAllowance(
  request: PaidExecutionRequest,
  inputTokens: number,
): number | null {
  const offer = request.quote.offer;
  const input = count(inputTokens);
  const inputPrice = BigInt(offer.prices.inputAtomicPerMtok);
  const outputPrice = BigInt(offer.prices.outputAtomicPerMtok);
  // ceil(cost / unit) <= ceiling exactly when cost <= ceiling * unit, the ceiling being whole.
  const budget =
    BigInt(offer.maxAtomic) * BigInt(V2_PRICING.tokensPerUnit) -
    input * inputPrice;
  const context = offer.model.contextTokens - inputTokens;
  if (budget < outputPrice || context < 1) return null;
  const affordable =
    outputPrice === 0n ? request.input.maxTokens : budget / outputPrice;
  return Number(
    [BigInt(request.input.maxTokens), BigInt(context), affordable].reduce(
      (low, value) => (value < low ? value : low),
    ),
  );
}

// The charge for recounted tokens: zero output and zero amount when nothing was delivered, and
// never above the deposited ceiling.
export function paidCharge(
  request: PaidExecutionRequest,
  usage: PaidUsage,
  delivered: boolean,
): PaidCharge {
  count(usage.inputTokens);
  count(usage.outputTokens);
  if (!delivered)
    return {
      inputTokens: usage.inputTokens,
      outputTokens: 0,
      chargedAtomic: '0',
    };
  const ceiling = BigInt(request.payment.maxAtomic);
  const priced = chargeV2(
    { input: usage.inputTokens, output: usage.outputTokens },
    request.quote.offer.prices,
  );
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    chargedAtomic: String(priced < ceiling ? priced : ceiling),
  };
}
