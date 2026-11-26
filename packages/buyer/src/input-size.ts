// The buyer's estimate of a request's input tokens, sent in quotes so a seller too slow to read it in
// time can refuse before the prompt is sent. The buyer holds no tokenizer for a free offer: about four
// bytes per token over the conversation and the tools offered. Every seller asked receives it, so it is
// rounded up to whole steps: an exact size next to a stable node id would link a conversation's turns.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

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

export const FIT_BYTES_PER_TOKEN = 3;
const unfitMarker = new WeakSet<FreeClientError>();
export function fittedInput<T extends FreeExecutionBuildInput>(
  input: T,
  contextTokens: number,
): T {
  const bytes = Buffer.byteLength(
    JSON.stringify([input.messages, input.tools ?? null]),
  );
  const room = contextTokens - Math.ceil(bytes / FIT_BYTES_PER_TOKEN);
  if (room < 1) {
    const error = new FreeClientError(FREE_EXECUTION_CODES.LIMIT, false);
    unfitMarker.add(error);
    throw error;
  }
  return room < input.maxTokens ? { ...input, maxTokens: room } : input;
}
export const tooLong = (error: unknown): error is FreeClientError =>
  error instanceof FreeClientError && unfitMarker.has(error);
