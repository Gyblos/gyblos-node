// The buyer's estimate of a request's input tokens, sent in quotes so a seller too slow to read it in
// time can refuse before the prompt is sent. The buyer holds no tokenizer for a free offer: about four
// bytes per token over the conversation and the tools offered. Every seller asked receives it, so it is
// rounded up to whole steps: an exact size next to a stable node id would link a conversation's turns.
import { DECLARED_METER } from '@gyblos/node/free-meter';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

export const BYTES_PER_TOKEN = 4;
export const INPUT_SIZE_STEP = 1024;

export function estimatedInputTokens(
  input: Pick<FreeExecutionBuildInput, 'messages' | 'tools'>,
) {
  const bytes = Buffer.byteLength(
    JSON.stringify([input.messages, input.tools ?? null]),
  );
  const tokens = Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN));
  return Math.ceil(tokens / INPUT_SIZE_STEP) * INPUT_SIZE_STEP;
}

export const MIN_FITTED_ANSWER = 256;
export function fittedAnswer(
  input: Pick<FreeExecutionBuildInput, 'messages' | 'tools' | 'maxTokens'>,
  offer: Pick<InferenceOfferV2, 'meteringMode' | 'model'>,
) {
  const used =
    offer.meteringMode === CONTROL_METERING_MODES.DECLARED
      ? DECLARED_METER.chat(input.messages, input.tools)
      : Math.ceil(
          Buffer.byteLength(
            JSON.stringify([input.messages, input.tools ?? null]),
          ) / BYTES_PER_TOKEN,
        );
  const room = offer.model.contextTokens - used;
  return room >= Math.min(input.maxTokens, MIN_FITTED_ANSWER)
    ? Math.min(room, input.maxTokens)
    : undefined;
}
