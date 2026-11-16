// Bounds and recounts paid engine output before delivery: text whose recounted tokens exceed what the
// deposit pays for stops the stream with BUDGET_EXHAUSTED before it is delivered. A failed delivery
// permanently stops publication; the final engine text must equal the delivered prefix.
import {
  ENGINE_ERROR_CODES,
  ENGINE_ERROR_STOP_REASON,
  FREE_EXECUTION,
  type FreeExecutionStopReason,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import {
  paidExecutionFail as fail,
  PaidExecutionError,
  type PaidExecutionFailure,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import { paidStreamDeltas } from '@gyblos/protocol/paid-stream';
import {
  PAID_DELIVERED_CODES,
  PAID_EXECUTION_CODES,
  PAID_REFUSAL_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';

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
  let textBytes = 0;
  // Only text whose delivery resolved; text above may hold a fragment still in flight.
  let deliveredText = '';
  let active = true;
  let inFlight = false;
  let failed = false;
  let failure: unknown;
  function checkAllowance(value: string) {
    const tokens = meter.streamed(value);
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      return fail(PAID_EXECUTION_CODES.INTERNAL);
    if (tokens > usage.allowance)
      return fail(PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
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
          chunks = paidStreamDeltas(delta);
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
          if (active) deliveredText = text;
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

// Wire-specific stop translation stays beside the delivered-prefix tracker, outside the common lifecycle.
function stopCode(
  error: unknown,
  signal: AbortSignal,
): { code: PaidExecutionCode; reason?: FreeExecutionStopReason } {
  if (signal.aborted)
    return {
      code:
        signal.reason instanceof PaidExecutionError &&
        signal.reason.code === PAID_EXECUTION_CODES.TIMEOUT
          ? PAID_EXECUTION_CODES.TIMEOUT
          : PAID_EXECUTION_CODES.CANCELLED,
    };
  if (error instanceof EngineError) {
    const reason: FreeExecutionStopReason | undefined =
      ENGINE_ERROR_STOP_REASON[error.code];
    return reason
      ? { code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE, reason }
      : { code: PAID_EXECUTION_CODES.ENGINE };
  }
  if (
    error instanceof PaidExecutionError &&
    !PAID_REFUSAL_CODES.includes(error.code) &&
    error.code !== PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE
  )
    return { code: error.code };
  return {
    code:
      error instanceof PaidExecutionError
        ? PAID_EXECUTION_CODES.INTERNAL
        : PAID_EXECUTION_CODES.ENGINE,
  };
}

export function stoppedAfterDeposit(
  error: unknown,
  signal: AbortSignal,
  output: ReturnType<typeof createPaidStreamOutput>,
  meter: FreeMeter,
  allowance: number,
): PaidExecutionFailure {
  const deliveryFailure = output.failure();
  // LIMIT raised by delivery stops an already deposited stream, rather than refusing admission.
  // Report only the acknowledged prefix; unrelated final-validation/internal errors stay unbillable.
  const stopped =
    deliveryFailure instanceof PaidExecutionError &&
    deliveryFailure.code === PAID_EXECUTION_CODES.LIMIT
      ? new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE)
      : (deliveryFailure ?? error);
  const { code, reason } = stopCode(stopped, signal);
  const delivered = output.delivered();
  const reports = delivered !== '' && PAID_DELIVERED_CODES.includes(code);
  const deliveredTokens = reports ? meter.delivered(delivered, allowance) : 0;
  if (
    reports &&
    (!Number.isSafeInteger(deliveredTokens) ||
      deliveredTokens < 1 ||
      deliveredTokens > allowance ||
      deliveredTokens > new TextEncoder().encode(delivered).length)
  )
    return fail(PAID_EXECUTION_CODES.INTERNAL);
  return {
    code,
    ...(reason ? { reason } : {}),
    ...(deliveredTokens
      ? { delivered: { outputTokens: deliveredTokens } }
      : {}),
  };
}
