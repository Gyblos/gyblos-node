// The buyer's estimate of a request's input tokens, sent in quotes so a seller too slow to read it in
// time can refuse before the prompt is sent. The buyer holds no tokenizer for a free offer: about four
// bytes per token over the conversation and the tools offered, as the token count endpoint estimates.
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

const BYTES_PER_TOKEN = 4;

export function estimatedInputTokens(
  input: Pick<FreeExecutionBuildInput, 'messages' | 'tools'>,
) {
  const bytes = Buffer.byteLength(
    JSON.stringify([input.messages, input.tools ?? null]),
  );
  return Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN));
}
