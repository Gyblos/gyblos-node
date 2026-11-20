// Bound each output chunk before delivery and verify the final text.
import { batchFail as fail } from '@gyblos/protocol/batch-channel';
import { batchStreamDeltas } from '@gyblos/protocol/batch-stream';
import { ENGINE_ERROR_CODES, FREE_EXECUTION } from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import type { FreeMeter } from './free-meter';

export function createBatchStreamOutput(
  meter: FreeMeter,
  allowance: number,
  signal: AbortSignal,
  deliver: (text: string) => Promise<void>,
  checkDeadline: () => void = () => {},
) {
  let text = '';
  let textBytes = 0;
  let active = true;
  let inFlight = false;
  let failed = false;
  let failure: unknown;
  function checkAllowance(value: string) {
    const tokens = meter.streamed(value);
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      return fail(PAID_EXECUTION_CODES.INTERNAL);
    if (tokens > allowance) return fail(PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
  }
  function check() {
    checkDeadline();
    if (signal.aborted || !active) return fail(PAID_EXECUTION_CODES.CANCELLED);
    if (failed) throw failure;
  }
  return {
    async onText(delta: string) {
      let entered = false;
      try {
        check();
        if (inFlight) return fail(PAID_EXECUTION_CODES.ENGINE);
        inFlight = true;
        entered = true;
        if (!delta) return;
        const combined = text + delta;
        checkAllowance(combined);
        // Validate each delta once and accumulate its bytes. Re-scanning the whole prefix for every
        // token is quadratic for long answers; the meter still recounts the combined text above.
        let chunks: string[];
        try {
          chunks = batchStreamDeltas(delta);
          const bytes = new TextEncoder().encode(delta).length;
          if (textBytes + bytes > FREE_EXECUTION.outputBytes)
            throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
          textBytes += bytes;
        } catch {
          throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
        }
        // Delivery acknowledges a bounded wire chunk, not a whole possibly multi-frame engine delta.
        // A cut on a later frame must retain the earlier acknowledged prefix for settlement.
        for (const chunk of chunks) {
          const prefix = text + chunk;
          // BPE counts are not monotonic: an intermediate prefix can cost more than the full delta.
          if (chunks.length > 1) checkAllowance(prefix);
          text = prefix;
          await deliver(chunk);
          checkDeadline();
          check();
        }
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
    complete(output: string) {
      check();
      active = false;
      if (inFlight || output !== text) return fail(PAID_EXECUTION_CODES.ENGINE);
    },
  };
}
