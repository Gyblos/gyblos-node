// Stop sequences (OpenAI `stop`, Anthropic `stop_sequences`), honored by the buyer on the answer it shows.
// Sellers do not receive them: the signed protocol has no field for them, and every seller would need an
// update. The buyer cuts the answer before the first sequence instead, whole or streamed, and ends it with
// the finish reason a provider gives. The seller still generates until its own end, so the usage reported
// (and, on a paid offer, charged) is what it generated, not only the text shown.
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import { CHAT_STOP, FREE_CHAT_DETAILS } from './constants';
import { invalidChat } from './free-chat-error';
import type { ChatResult, FreeChatStreamExecutor } from './free-sse';

// A string or a list of strings; null, absent or an empty list asks for nothing.
export function parseStop(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length > CHAT_STOP.maxSequences)
    throw invalidChat(field, FREE_CHAT_DETAILS.stop);
  for (const entry of list)
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      Buffer.byteLength(entry) > CHAT_STOP.maxBytes
    )
      throw invalidChat(field, FREE_CHAT_DETAILS.stop);
  return list.length ? (list as string[]) : undefined;
}

// The earliest sequence in the text, at or after `from`.
function firstStop(text: string, stops: readonly string[], from = 0) {
  let found: { index: number; sequence: string } | undefined;
  for (const sequence of stops) {
    const index = text.indexOf(sequence, from);
    if (index >= 0 && (!found || index < found.index))
      found = { index, sequence };
  }
  return found;
}

// The answer as shown: cut before the first sequence. A cut answer ends there, so calls the model would
// have made after it are dropped, as a provider stopping generation would never have produced them.
export function stoppedResult(
  result: ChatResult,
  stops: readonly string[],
  found = firstStop(result.text, stops),
): ChatResult {
  if (!found) return result;
  const { toolCalls: _calls, ...rest } = result;
  return {
    ...rest,
    text: result.text.slice(0, found.index),
    finishReason: ENGINE_DONE_REASONS.STOP,
    stopSequence: found.sequence,
  };
}

// A stream that shows text up to the first sequence. It holds back the last few characters that could begin
// a sequence until the next fragment settles them, and shows nothing after a sequence; the rest is flushed
// when the seller finishes.
export function stoppingStream(
  execute: FreeChatStreamExecutor,
  stops: readonly string[],
): FreeChatStreamExecutor {
  const hold = Math.max(...stops.map((stop) => stop.length)) - 1;
  return async (input, signal, onDelta, model, permission) => {
    let seen = '';
    let shown = 0;
    let found: ReturnType<typeof firstStop>;
    let digest: string | undefined;
    const show = async (end: number) => {
      if (end <= shown) return;
      const fragment = seen.slice(shown, end);
      shown = end;
      await onDelta(fragment, digest);
    };
    const result = await execute(
      input,
      signal,
      async (fragment, requestDigest) => {
        digest = requestDigest ?? digest;
        if (found) return;
        seen += fragment;
        found = firstStop(seen, stops, Math.max(0, shown - hold));
        await show(found ? found.index : seen.length - hold);
      },
      model,
      permission,
    );
    const stopped = stoppedResult(result, stops, found);
    await show(stopped.text.length);
    return stopped;
  };
}

// The request a seller receives: everything but the buyer's own stop sequences.
export function withoutStop<Input extends FreeExecutionBuildInput>(
  input: Input & { stop?: string[] },
): Input {
  const { stop: _stop, ...rest } = input;
  return rest as Input;
}
