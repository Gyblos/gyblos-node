// Recounts the entire quote-bound conversation before any session reservation or financial construction.
import { batchExecutionInput, batchFail } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { chargeV2 } from './pricing-v2';

export function recountSessionInput(
  quote: SignedOfferV2,
  data: FreeExecutionBuildInput,
  meter: Pick<ChatTokenizer, 'chat'>,
) {
  const input = batchExecutionInput(quote, data);
  if (
    quote.offer.reasoning !== REASONING_LEVELS.OFF ||
    quote.offer.meteringMode !== CONTROL_METERING_MODES.RECOUNTED
  )
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  let inputTokens: number;
  try {
    inputTokens = meter.chat(input.messages);
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
