// Observes verified buyer attempts and unavailable selection; never retries, stores content or guesses an engine kind.
import {
  createExecutionTelemetry,
  emitTelemetry,
  telemetrySizes,
} from '@gyblos/core/telemetry';
import { FREE_EXECUTION_CODES, P2P_ROLES } from '@gyblos/protocol/constants';
import type {
  FreeExecutionRequest,
  FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import type { FreeBuyerDependencies } from './free-execution';

export function buyerExecutionTelemetry(
  request: FreeExecutionRequest,
  dependencies: FreeBuyerDependencies,
  streaming: boolean,
) {
  const telemetry = dependencies.telemetry;
  if (!telemetry) return undefined;
  const observer = createExecutionTelemetry({
    sink: telemetry.sink,
    now: telemetry.now ?? Date.now,
    context: {
      role: P2P_ROLES.BUYER,
      buyerNodeId: telemetry.buyerNodeId,
      sellerNodeId: request.quote.offer.nodeId,
      requestId: request.requestId,
      selection: request.input.selection,
      meteringMode: request.quote.offer.meteringMode,
      streaming,
      engineKind: null,
    },
  });
  return observer;
}
export function failBuyerTelemetry(
  observer: ReturnType<typeof buyerExecutionTelemetry>,
  error: unknown,
  signal: AbortSignal,
  delivered: boolean,
) {
  if (
    error instanceof FreeClientError &&
    !error.sent &&
    !delivered &&
    !signal.aborted
  )
    observer?.refused(TELEMETRY_REFUSALS.CONNECT_FAILED);
  else
    observer?.failed(
      signal.aborted
        ? FREE_EXECUTION_CODES.CANCELLED
        : error instanceof FreeClientError
          ? error.code
          : FREE_EXECUTION_CODES.INTERNAL,
      error instanceof FreeClientError ? error : {},
    );
}
export function completeBuyerTelemetry(
  observer: ReturnType<typeof buyerExecutionTelemetry>,
  request: FreeExecutionRequest,
  result: FreeExecutionResult,
) {
  observer?.completed(
    { ...result.usage, reasoningTokens: null },
    result.finishReason,
    telemetrySizes(request.input.messages[0]?.content ?? '', result.text),
  );
}
export function buyerUnserved(
  dependencies: FreeBuyerDependencies,
  streaming: boolean,
) {
  const telemetry = dependencies.telemetry;
  if (!telemetry) return;
  try {
    emitTelemetry(telemetry.sink, {
      type: TELEMETRY_EVENTS.UNSERVED,
      role: P2P_ROLES.BUYER,
      at: (telemetry.now ?? Date.now)(),
      buyerNodeId: telemetry.buyerNodeId,
      selection: {
        modelId: telemetry.selection.modelId,
        variant: telemetry.selection.variant,
        quantization: telemetry.selection.quantization,
      },
      streaming,
      requestId: null,
      sellerNodeId: null,
      engineKind: null,
    });
  } catch {
    /* Observational failures never replace the selection failure. */
  }
}
