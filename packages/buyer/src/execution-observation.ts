// Observes one already selected paid attempt through the common inference observer; no prompt persistence.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import { TELEMETRY_REFUSALS } from '@gyblos/protocol/telemetry';

import type { FreeBuyerDependencies, FreeWinner } from './free-execution';
import {
  buyerExecutionTelemetry,
  completeBuyerTelemetry,
} from './free-telemetry';

export async function observeBuyerExecution<
  Result extends FreeExecutionResult | undefined,
>(
  dependencies: FreeBuyerDependencies,
  winner: FreeWinner,
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta: ((text: string, digest?: string) => Promise<void>) | undefined,
  run: (emit: typeof onDelta) => Promise<Result>,
): Promise<Result> {
  const request = {
    requestId: winner.quote.offer.requestId,
    quote: winner.quote,
    input: {
      ...input,
      messages: [...input.messages],
      selection: winner.quote.offer.selection,
      reasoning: winner.quote.offer.reasoning,
    },
  };
  const observer = buyerExecutionTelemetry(
    request,
    dependencies,
    Boolean(onDelta),
  );
  observer?.received();
  try {
    const result = await run(
      onDelta
        ? async (text, digest) => {
            await onDelta(text, digest);
            if (text && !signal.aborted) observer?.firstToken();
          }
        : undefined,
    );
    if (result) completeBuyerTelemetry(observer, request, result);
    else observer?.refused(TELEMETRY_REFUSALS.CONNECT_FAILED);
    return result;
  } catch (error) {
    observer?.failed(
      signal.aborted
        ? FREE_EXECUTION_CODES.CANCELLED
        : FREE_EXECUTION_CODES.INTERNAL,
    );
    throw error;
  }
}
