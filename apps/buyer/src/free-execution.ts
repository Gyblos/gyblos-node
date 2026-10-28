// Orchestrates free quote execution with failover only before possible prompt transmission.
// Selection and I/O are injected; this module never authorizes payments or records content.
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
import {
  buyerExecutionTelemetry,
  buyerUnserved,
  completeBuyerTelemetry,
  failBuyerTelemetry,
} from './free-telemetry';
import type { SelectionDecision } from './selection';

export class FreeSelectionFailure extends Error {
  constructor(readonly decision: Exclude<SelectionDecision, { ok: true }>) {
    super(decision.code);
    this.name = 'FreeSelectionFailure';
  }
}
export interface FreeWinner {
  nodeId: string;
  quote: SignedOfferV2;
}

export interface FreeBuyerDependencies {
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
          buyerUnserved(dependencies, Boolean(onDelta));
          throw error;
        });
      signal.throwIfAborted();
      if (excluded.has(winner.nodeId))
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      excluded.add(winner.nodeId);
      const request = buildFreeExecutionRequest(winner.quote, input);
      const observer = buyerExecutionTelemetry(
        request,
        dependencies,
        Boolean(onDelta),
      );
      observer?.received();
      let delivered = false;
      const emit = onDelta
        ? async (text: string) => {
            signal.throwIfAborted();
            delivered = true;
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
        );
        signal.throwIfAborted();
        completeBuyerTelemetry(observer, request, result);
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
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  } finally {
    release?.();
  }
}
