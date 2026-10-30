// Runs one paid generation within what the deposit pays for and names how a generation that stopped
// after the deposit ended: the stop code, the engine's reason and the recounted delivered output the
// buyer is charged for. Refusal codes never follow a deposit, so they become internal failures.
import {
  ENGINE_ERROR_STOP_REASON,
  type FreeExecutionStopReason,
} from '@gyblos/protocol/constants';
import { EngineError, type Engine } from '@gyblos/protocol/engine';
import type { FreeExecutionResult } from '@gyblos/protocol/free-execution';
import {
  paidExecutionFail as fail,
  PaidExecutionError,
  type PaidExecutionFailure,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_DELIVERED_CODES,
  PAID_EXECUTION_CODES,
  PAID_REFUSAL_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';

import type { FreeMeter } from './free-meter';
import type { createPaidStreamOutput } from './paid-stream-output';

export type PaidStreamOutput = ReturnType<typeof createPaidStreamOutput>;

export interface PaidGeneration {
  prompt: string;
  inputTokens: number;
  allowance: number;
  contextTokens: number;
}

export async function generatePaid(
  generation: PaidGeneration,
  output: PaidStreamOutput,
  signal: AbortSignal,
  engine: Engine,
  meter: FreeMeter,
): Promise<FreeExecutionResult> {
  let produced: Awaited<ReturnType<Engine['generate']>>;
  try {
    produced = await engine.generate({
      prompt: generation.prompt,
      // Never more than the deposit pays for; the stream also stops on the recount.
      maxTokens: generation.allowance,
      signal,
      onText: output.onText,
    });
    output.complete(produced.text);
  } finally {
    output.stop();
  }
  const usage = meter.usage(
    produced.text,
    produced.usage,
    generation.inputTokens,
  );
  if (
    !usage ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.outputTokens > generation.allowance ||
    usage.inputTokens + usage.outputTokens > generation.contextTokens
  )
    return fail(PAID_EXECUTION_CODES.INTERNAL);
  return {
    text: produced.text,
    usage,
    finishReason: produced.finishReason,
  };
}

function stopCode(
  error: unknown,
  signal: AbortSignal,
): { code: PaidExecutionCode; reason?: FreeExecutionStopReason } {
  if (signal.aborted) return { code: PAID_EXECUTION_CODES.CANCELLED };
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
  if (error instanceof PaidExecutionError)
    return { code: PAID_EXECUTION_CODES.INTERNAL };
  return { code: PAID_EXECUTION_CODES.ENGINE };
}

// How a generation that stopped after the deposit is reported; the stream's own failure wins over
// an engine error that wrapped it.
export function stoppedAfterDeposit(
  error: unknown,
  signal: AbortSignal,
  output: PaidStreamOutput,
  meter: FreeMeter,
  allowance: number,
): PaidExecutionFailure {
  const { code, reason } = stopCode(output.failure() ?? error, signal);
  const delivered = output.delivered();
  return {
    code,
    ...(reason ? { reason } : {}),
    ...(delivered && PAID_DELIVERED_CODES.includes(code)
      ? { delivered: { outputTokens: meter.delivered(delivered, allowance) } }
      : {}),
  };
}
