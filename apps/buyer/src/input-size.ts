// The buyer's estimate of a request's input tokens, sent in quotes so a seller too slow to read it in
// time can refuse before the prompt is sent. The buyer holds no tokenizer for a free offer: about four
// bytes per token over the conversation and the tools offered. Every seller asked receives it, so it is
// rounded up to whole steps: an exact size next to a stable node id would link a conversation's turns.
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
