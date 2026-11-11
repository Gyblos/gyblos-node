// Bounds and counts incremental engine output before delivery; a failed callback permanently stops publication.
// The final complete engine text must equal the already delivered prefix, never a synthesized fallback.
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import {
  freeExecutionFail as fail,
  parseFreeExecutionResponse,
  type FreeExecutionRequest,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';

import type { FreeMeter } from './free-meter';

// The exact recount and response bounds of the whole streamed text.
function checkStreamed(
  request: FreeExecutionRequest,
  header: Pick<
    FreeExecutionResponse,
    'version' | 'requestId' | 'requestDigest'
  >,
  meter: FreeMeter,
  inputTokens: number,
  text: string,
) {
  const tokens = meter.streamed(text);
  if (
    !Number.isSafeInteger(tokens) ||
    tokens < 0 ||
    tokens > request.input.maxTokens
  )
    return fail(FREE_EXECUTION_CODES.LIMIT);
  parseFreeExecutionResponse({
    ...header,
    result: {
      text,
      usage: { inputTokens, outputTokens: tokens },
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
  });
}

export function createFreeStreamOutput(
  request: FreeExecutionRequest,
  header: Pick<
    FreeExecutionResponse,
    'version' | 'requestId' | 'requestDigest'
  >,
  meter: FreeMeter,
  inputTokens: number,
  signal: AbortSignal,
  deliver: (text: string) => Promise<void>,
) {
  let text = '';
  // Upper bounds of the text's tokens and of its escaped JSON size, summed per fragment.
  let tokenBound = 0;
  let wireBound = 0;
  // Only text whose delivery resolved; text above may hold a fragment still in flight. A delivery that
  // rejected after writing its bytes is not counted, so the buyer then rejects the terminal instead.
  let deliveredText = '';
  let active = true;
  let inFlight = false;
  let failed = false;
  let failure: unknown;
  function check() {
    if (signal.aborted || !active) return fail(FREE_EXECUTION_CODES.CANCELLED);
    if (failed) throw failure;
  }
  return {
    async onText(delta: string) {
      let entered = false;
      try {
        check();
        if (inFlight) return fail(FREE_EXECUTION_CODES.ENGINE);
        inFlight = true;
        entered = true;
        if (!delta) return;
        const combined = text + delta;
        // Each fragment's own count and escaped size bound the whole text's, so the exact recount and
        // response check run only once those bounds near a limit: a long answer stays linear.
        tokenBound += meter.streamed(delta) + 1;
        wireBound += Buffer.byteLength(JSON.stringify(delta));
        if (
          tokenBound > request.input.maxTokens ||
          wireBound > FREE_EXECUTION.outputBytes
        )
          checkStreamed(request, header, meter, inputTokens, combined);
        text = combined;
        await deliver(delta);
        deliveredText = combined;
        check();
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        if (entered) inFlight = false;
      }
    },
    stop() {
      active = false;
    },
    delivered: () => deliveredText,
    complete(output: string) {
      check();
      active = false;
      if (inFlight) return fail(FREE_EXECUTION_CODES.ENGINE);
      if (output !== text)
        return fail(
          text ? FREE_EXECUTION_CODES.ENGINE : FREE_EXECUTION_CODES.UNSUPPORTED,
        );
    },
  };
}
