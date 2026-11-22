// A declared paid offer bills the usage its engine's provider reports: no public tokenizer is pinned for the
// model, so the buyer cannot recount it. It can still bound it. No token holds less than one UTF-8 byte, so
// the conversation's bytes (with the template allowance DECLARED_METER gives each message) are the most input
// an honest count can reach, and the delivered text's bytes (with one allowance) the most output; no token
// holds more than declaredMaxTokenBytes either. A bill outside those bounds or past maxTokens is refused, so
// the seller is not paid for it. Pure.
import { INFERENCE_CODES } from '@gyblos/protocol/constants';
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
  const delivered = bytes(
    result.text +
      (result.toolCalls ?? [])
        .map((call) => call.name + call.arguments)
        .join(''),
  );
  if (
    !count(inputTokens) ||
    !count(outputTokens) ||
    inputTokens < 1 ||
    inputTokens > DECLARED_METER.chat(input.messages, input.tools) ||
    outputTokens > input.maxTokens ||
    outputTokens > delivered + FREE_METERING.declaredTemplateTokens ||
    outputTokens < Math.ceil(delivered / FREE_METERING.declaredMaxTokenBytes)
  )
    throw new InferenceError(INFERENCE_CODES.INVALID);
  return { inputTokens, outputTokens };
}
