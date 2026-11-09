// Emits seller execution observations only after quote and peer verification; never logs content or changes policy.
import {
  createExecutionTelemetry,
  telemetrySizes,
  type RouteProbe,
} from '@gyblos/core/telemetry';
import { FREE_EXECUTION_CODES, P2P_ROLES } from '@gyblos/protocol/constants';
import type {
  FreeExecutionRequest,
  FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import {
  TELEMETRY_REFUSALS,
  type TelemetryRefusal,
} from '@gyblos/protocol/telemetry';

import type { SellerFreeExecutionOptions } from './free-execution';

function refusal(code: FreeExecutionResponse['error']): TelemetryRefusal {
  switch (code?.code) {
    case FREE_EXECUTION_CODES.BUSY:
      return TELEMETRY_REFUSALS.SELLER_BUSY;
    case FREE_EXECUTION_CODES.DAILY_CAP:
      return TELEMETRY_REFUSALS.DAILY_CAP;
    case FREE_EXECUTION_CODES.BUYER_CAP:
      return TELEMETRY_REFUSALS.BUYER_CAP;
    case FREE_EXECUTION_CODES.ENGINE:
      return TELEMETRY_REFUSALS.ENGINE_NOT_READY;
    default:
      return TELEMETRY_REFUSALS.QUOTE_REJECTED;
  }
}
export function sellerExecutionTelemetry(
  request: FreeExecutionRequest,
  options: SellerFreeExecutionOptions,
  streaming: boolean,
  route?: RouteProbe,
) {
  const telemetry = options.telemetry;
  if (!telemetry) return undefined;
  const observer = createExecutionTelemetry({
    sink: telemetry.sink,
    now: telemetry.now ?? Date.now,
    ...(route ? { route } : {}),
    context: {
      role: P2P_ROLES.SELLER,
      buyerNodeId: request.quote.offer.buyerNodeId,
      sellerNodeId: options.nodeId,
      requestId: request.requestId,
      selection: request.input.selection,
      streaming,
      meteringMode: options.meter.mode,
      engineKind: telemetry.engineKind,
    },
  });
  observer.received();
  return observer;
}
export function finishSellerTelemetry(
  observer: ReturnType<typeof sellerExecutionTelemetry>,
  request: FreeExecutionRequest,
  response: FreeExecutionResponse,
  started: boolean,
) {
  if (!observer) return;
  if (response.result) {
    observer.completed(
      { ...response.result.usage, reasoningTokens: null },
      response.result.finishReason,
      telemetrySizes(
        request.input.messages[0]?.content ?? '',
        response.result.text,
      ),
    );
  } else if (started || response.error.code === FREE_EXECUTION_CODES.CANCELLED)
    observer.failed(response.error.code, response.error);
  else observer.refused(refusal(response.error));
}
