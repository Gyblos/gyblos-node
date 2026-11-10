// Maps paid wire outcomes to the existing observational categories; financial evidence stays explicit.
// Never changes execution, exposes content or reports a pending claim as a confirmed charge.
import { emitTelemetry, telemetrySizes } from '@gyblos/core/telemetry';
import { FREE_EXECUTION_CODES, P2P_ROLES } from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';
import type {
  PaidExecutionRequest,
  PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';

import type { sellerExecutionTelemetry } from './free-telemetry';
import type { SellerPaidExecutionOptions } from './paid-execution';

function stopCategory(code: PaidExecutionCode) {
  switch (code) {
    case PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE:
      return FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE;
    case PAID_EXECUTION_CODES.BUDGET_EXHAUSTED:
      return FREE_EXECUTION_CODES.LIMIT;
    case PAID_EXECUTION_CODES.TIMEOUT:
      return FREE_EXECUTION_CODES.TIMEOUT;
    case PAID_EXECUTION_CODES.CANCELLED:
      return FREE_EXECUTION_CODES.CANCELLED;
    case PAID_EXECUTION_CODES.ENGINE:
      return FREE_EXECUTION_CODES.ENGINE;
    default:
      return FREE_EXECUTION_CODES.INTERNAL;
  }
}
function refusal(code: PaidExecutionCode) {
  if (code === PAID_EXECUTION_CODES.BUSY) return TELEMETRY_REFUSALS.SELLER_BUSY;
  if (code === PAID_EXECUTION_CODES.ENGINE)
    return TELEMETRY_REFUSALS.ENGINE_NOT_READY;
  return TELEMETRY_REFUSALS.QUOTE_REJECTED;
}

export function finishPaidTelemetry(
  observer: ReturnType<typeof sellerExecutionTelemetry>,
  request: PaidExecutionRequest,
  response: PaidExecutionResponse,
  admitted: boolean,
  options: SellerPaidExecutionOptions,
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
  } else if (
    admitted ||
    response.error.code === PAID_EXECUTION_CODES.CANCELLED
  ) {
    const stop: FreeExecutionStop = response.error;
    observer.failed(stopCategory(response.error.code), stop);
  } else observer.refused(refusal(response.error.code));
  const settlement = response.payment?.settlement;
  const telemetry = options.telemetry;
  if (!settlement || !telemetry) return;
  try {
    emitTelemetry(telemetry.sink, {
      type: TELEMETRY_EVENTS.CHARGED,
      at: (telemetry.now ?? Date.now)(),
      role: P2P_ROLES.SELLER,
      requestId: request.requestId,
      buyerNodeId: request.quote.offer.buyerNodeId,
      sellerNodeId: options.nodeId,
      selection: request.input.selection,
      streaming: true,
      meteringMode: options.meter.mode,
      engineKind: telemetry.engineKind,
      amountAtomic: settlement.chargedAtomic,
      feeAtomic: settlement.feeAtomic,
      network: request.quote.offer.network,
      asset: request.quote.offer.mint,
    });
  } catch {
    // An observer or clock never changes a financial outcome.
  }
}
