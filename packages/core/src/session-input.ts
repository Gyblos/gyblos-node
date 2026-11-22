// Recounts the entire quote-bound conversation before any session reservation or financial construction;
// a declared offer, which has no public tokenizer, is estimated from its bytes instead.
import { batchExecutionInput, batchFail } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { inferenceNeedsTools } from '@gyblos/protocol/inference';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { toolMessageBytes, toolsBytes } from '@gyblos/protocol/tools';

import { DECLARED_ESTIMATE } from './constants';
import { chargeV2 } from './pricing-v2';

// A declared offer's prompt, before execution: its bytes at a typical bytes-per-token ratio.
function declaredEstimate(input: ReturnType<typeof batchExecutionInput>) {
  const bytes = input.messages.reduce<number>(
    (sum, message) => sum + toolMessageBytes(message),
    toolsBytes(input.tools),
  );
  return Math.ceil(bytes / DECLARED_ESTIMATE.bytesPerToken);
}

export function recountSessionInput(
  quote: SignedOfferV2,
  data: FreeExecutionBuildInput,
  meter: Pick<ChatTokenizer, 'chat' | 'output'> & {
    supportsToolCalls?: boolean;
  },
) {
  const input = batchExecutionInput(quote, data);
  const mode = quote.offer.meteringMode;
  if (
    quote.offer.reasoning !== REASONING_LEVELS.OFF ||
    (mode !== CONTROL_METERING_MODES.RECOUNTED &&
      mode !== CONTROL_METERING_MODES.DECLARED)
  )
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  let inputTokens: number;
  try {
    if (mode === CONTROL_METERING_MODES.DECLARED)
      inputTokens = declaredEstimate(input);
    else {
      if (
        inferenceNeedsTools(input) &&
        !meter.output &&
        !meter.supportsToolCalls
      )
        return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
      inputTokens = meter.chat(input.messages, input.tools, input.toolChoice);
    }
  } catch {
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  }
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens + input.maxTokens > quote.offer.model.contextTokens
  )
    return batchFail(PAID_EXECUTION_CODES.LIMIT);
  if (
    chargeV2(
      { input: inputTokens, output: input.maxTokens },
      quote.offer.prices,
    ) > BigInt(quote.offer.maxAtomic)
  )
    return batchFail(PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
  return { input, inputTokens };
}
