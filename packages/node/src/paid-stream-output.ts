// Bounds and recounts paid engine output before delivery: text whose recounted tokens exceed what the
// deposit pays for stops the stream with BUDGET_EXHAUSTED before it is delivered. A failed delivery
// permanently stops publication; the final engine text must equal the delivered prefix.
import { ENGINE_ERROR_CODES } from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import {
  paidExecutionFail as fail,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import { paidStreamDeltas } from '@gyblos/protocol/paid-stream';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import type { FreeMeter } from './free-meter';

export type PaidHeader = Pick<
  PaidExecutionResponse,
  'version' | 'requestId' | 'requestDigest'
>;

export function createPaidStreamOutput(
  meter: FreeMeter,
  usage: { inputTokens: number; allowance: number },
  signal: AbortSignal,
  deliver: (text: string) => Promise<void>,
  checkDeadline: () => void = () => {},
) {
  let text = '';
  // Only text whose delivery resolved; text above may hold a fragment still in flight.
  let deliveredText = '';
  let active = true;
  let inFlight = false;
  let failed = false;
  let failure: unknown;
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
        const tokens = meter.streamed(combined);
        if (!Number.isSafeInteger(tokens) || tokens < 0)
          return fail(PAID_EXECUTION_CODES.INTERNAL);
        if (tokens > usage.allowance)
          return fail(PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
        // The combined text must stay sendable; otherwise the engine produced an invalid response.
        try {
          paidStreamDeltas(combined);
        } catch {
          throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
        }
        text = combined;
        await deliver(delta);
        checkDeadline();
        if (active) deliveredText = combined;
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
    // The delivery or budget failure that stopped the stream, which the engine may have wrapped.
    failure: () => (failed ? failure : undefined),
    complete(output: string) {
      check();
      active = false;
      if (inFlight || output !== text) return fail(PAID_EXECUTION_CODES.ENGINE);
    },
  };
}
