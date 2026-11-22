// A declared paid offer bills the usage its engine's provider reports: no public tokenizer is pinned for the
// model, so the buyer cannot recount it. It can still bound it. No token holds less than one UTF-8 byte, so
// the conversation's bytes (with the template allowance DECLARED_METER gives each message) are the most input
// an honest count can reach, and the delivered text's bytes (with an allowance for the reply and for each tool
// call) the most output; no token holds more than declaredMaxTokenBytes either. The seller bills within the
// same bounds and never past the quote's maxAtomic, so an honest bill is always approved; the buyer refuses
// anything else, and the seller is not paid for it. Pure.
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { INFERENCE_CODES } from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import {
  InferenceError,
  type InferenceBuildInput,
  type InferenceResult,
  type InferenceUsage,
} from '@gyblos/protocol/inference';
import { checkToolCalls } from '@gyblos/protocol/tools';

import { FREE_METERING } from './constants';
import { DECLARED_METER } from './free-meter';

const bytes = (text: string) => new TextEncoder().encode(text).length;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

type Delivered = Pick<InferenceResult, 'text' | 'toolCalls'>;

// The most and fewest tokens an honest count of this request and delivery can reach.
function declaredBounds(input: InferenceBuildInput, result: Delivered) {
  const calls = result.toolCalls ?? [];
  const delivered = bytes(
    result.text + calls.map((call) => call.name + call.arguments).join(''),
  );
  return {
    input: DECLARED_METER.chat(input.messages, input.tools),
    output: Math.min(
      input.maxTokens,
      delivered + FREE_METERING.declaredTemplateTokens * (1 + calls.length),
    ),
    outputFloor: Math.ceil(delivered / FREE_METERING.declaredMaxTokenBytes),
  };
}

// The seller's bill: the provider's count, held to the bounds the buyer will check.
export function boundDeclaredUsage(
  input: InferenceBuildInput,
  result: Delivered & { usage: InferenceUsage },
): InferenceUsage {
  const bounds = declaredBounds(input, result);
  return {
    inputTokens: Math.max(1, Math.min(result.usage.inputTokens, bounds.input)),
    // A count below the delivered text's floor is refused earlier (DECLARED_METER.usage); this only keeps
    // the bill inside both bounds.
    outputTokens: Math.min(
      Math.max(bounds.outputFloor, result.usage.outputTokens),
      bounds.output,
    ),
  };
}

// The buyer's check of a declared bill; refuses anything outside the bounds.
export function verifyDeclaredUsage(
  input: InferenceBuildInput,
  result: InferenceResult,
): InferenceUsage {
  try {
    checkToolCalls(input, result.toolCalls);
  } catch {
    throw new InferenceError(INFERENCE_CODES.INVALID);
  }
  const { inputTokens, outputTokens } = result.usage;
  const bounds = declaredBounds(input, result);
  if (
    !count(inputTokens) ||
    !count(outputTokens) ||
    inputTokens < 1 ||
    inputTokens > bounds.input ||
    outputTokens > bounds.output ||
    outputTokens < bounds.outputFloor
  )
    throw new InferenceError(INFERENCE_CODES.INVALID);
  return { inputTokens, outputTokens };
}

// What a declared request costs: its price, never past what the buyer agreed to pay for it.
export const declaredCharge = (
  usage: InferenceUsage,
  offer: Pick<InferenceOfferV2, 'prices' | 'maxAtomic'>,
) => {
  const charge = chargeV2(
    { input: usage.inputTokens, output: usage.outputTokens },
    offer.prices,
  );
  const ceiling = BigInt(offer.maxAtomic);
  return String(charge < ceiling ? charge : ceiling);
};
