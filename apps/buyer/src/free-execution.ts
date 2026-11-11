// Orchestrates free quote execution with failover only before possible prompt transmission.
// Selection and I/O are injected; this module never authorizes payments or records content.
import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import type {
  ModelSelection,
  SignedOfferV2,
} from '@gyblos/protocol/control-types';
import {
  buildFreeExecutionRequest,
  type FreeExecutionBuildInput,
  type FreeExecutionRequest,
  type FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { FREE_BUYER, FREE_BUYER_CODES } from './constants';
import { FreeBuyerError } from './free-chat';
import { buyerReceiptObservation } from './free-receipts';
import {
  buyerExecutionTelemetry,
  buyerUnserved,
  completeBuyerTelemetry,
  failBuyerTelemetry,
} from './free-telemetry';
import type { SelectionDecision } from './selection';

export class FreeSelectionFailure extends Error {
  // retryAt: when no seller is left because every one failed recently, the earliest cooldown end.
  constructor(
    readonly decision: Exclude<SelectionDecision, { ok: true }>,
    readonly retryAt?: number,
  ) {
    super(decision.code);
    this.name = 'FreeSelectionFailure';
  }
}
export interface FreeWinner {
  nodeId: string;
  quote: SignedOfferV2;
}

export interface FreeBuyerDependencies {
  receipt?: (
    winner: FreeWinner,
    evidence: BuyerReceiptEvidence,
    signal: AbortSignal,
  ) => Promise<void>;
  receiptNow?: () => number;
  telemetry?: {
    sink: TelemetrySink;
    buyerNodeId: string;
    selection: ModelSelection;
    now?: () => number;
  };
  enter?(): () => void;
  select(
    excluded: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<FreeWinner>;
  execute(
    winner: FreeWinner,
    request: FreeExecutionRequest,
    signal: AbortSignal,
    onDelta?: (text: string) => Promise<void>,
    beforeExecute?: () => void,
  ): Promise<FreeExecutionResult>;
}
export async function executeBuyerFree(
  input: FreeExecutionBuildInput,
  dependencies: FreeBuyerDependencies,
  external?: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const release = dependencies.enter?.();
  try {
    const signal = AbortSignal.any([
      AbortSignal.timeout(FREE_BUYER.requestMs),
      ...(external ? [external] : []),
    ]);
    const excluded = new Set<string>();
    while (!signal.aborted) {
      const winner = await dependencies
        .select(excluded, signal)
        .catch((error) => {
          if (!signal.aborted) buyerUnserved(dependencies, Boolean(onDelta));
          throw error;
        });
      signal.throwIfAborted();
      if (excluded.has(winner.nodeId))
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      excluded.add(winner.nodeId);
      const result = await executeSelectedBuyerFree(
        input,
        dependencies,
        winner,
        signal,
        onDelta,
      );
      if (result) return result;
    }
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  } finally {
    release?.();
  }
}

// Caller owns the request admission, deadline and exclusion set; this never selects another seller.
export async function executeSelectedBuyerFree(
  input: FreeExecutionBuildInput,
  dependencies: FreeBuyerDependencies,
  winner: FreeWinner,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
  beforeExecute?: () => void,
): Promise<FreeExecutionResult | undefined> {
  const request = buildFreeExecutionRequest(winner.quote, input);
  const observer = buyerExecutionTelemetry(
    request,
    dependencies,
    Boolean(onDelta),
  );
  observer?.received();
  const receipt = buyerReceiptObservation(dependencies, Boolean(onDelta));
  let delivered = false;
  const emit = onDelta
    ? async (text: string) => {
        signal.throwIfAborted();
        delivered = true;
        receipt?.text(text);
        await onDelta(text);
        signal.throwIfAborted();
        if (text) observer?.firstToken();
      }
    : undefined;
  try {
    const result = await dependencies.execute(
      winner,
      request,
      signal,
      emit,
      beforeExecute,
    );
    signal.throwIfAborted();
    completeBuyerTelemetry(observer, request, result);
    await receipt?.finish(winner, request, result, signal);
    return result;
  } catch (error) {
    failBuyerTelemetry(observer, error, signal, delivered);
    if (
      !(error instanceof FreeClientError) ||
      error.sent ||
      delivered ||
      signal.aborted
    )
      throw error;
  }
}
