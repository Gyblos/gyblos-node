// Bounds and recounts paid engine output before delivery: text whose recounted tokens exceed what the
// deposit pays for stops the stream with BUDGET_EXHAUSTED before it is delivered. A failed delivery
// permanently stops publication; the final engine text must equal the delivered prefix.
import {
  ENGINE_ERROR_CODES,
  ENGINE_ERROR_STOP_REASON,
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
  const { code, reason } = stopCode(output.failure() ?? error, signal);
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
