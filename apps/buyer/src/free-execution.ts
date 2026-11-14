// Orchestrates free quote execution with failover to another seller: before the prompt may have been
// sent, and, when resending is allowed, after it was sent as long as no visible text reached the client.
// Selection and I/O are injected; this module never authorizes payments or records content.
import { createHmac, randomBytes } from 'node:crypto';

import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
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
import { inferenceNeedsTools } from '@gyblos/protocol/inference';
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
import type { RoutedModel } from './model-routes';
import type { SelectionDecision } from './selection';
import type { StaticControlSeller } from './selection-config';

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
  // How to reach a seller found only in the index (open discovery); configured sellers are looked up.
  seller?: StaticControlSeller;
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
  conversationKey?: ReturnType<typeof createConversationKey>;
  // selection.json `failover`: "safe" (the default) lets a request whose seller failed after the prompt
  // was sent, but before any visible text, go to another seller; "never" keeps the prompt on one seller.
  resendAfterSend?: boolean;
  enter?(): () => void;
  // Hands a selected seller back once this request is done with it (free requests side by side).
  done?(winner: FreeWinner): void;
  // `needs.tools`: only a seller that serves tools may win; `needs.model`: the routed model to quote;
  // `needs.conversation`: a digest of the conversation's opening, to go back to the seller that served it.
  select(
    excluded: ReadonlySet<string>,
    signal: AbortSignal,
    needs?: { tools?: boolean; model?: RoutedModel; conversation?: string },
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
  model?: RoutedModel,
) {
  const release = dependencies.enter?.();
  try {
    const signal = AbortSignal.any([
      AbortSignal.timeout(FREE_BUYER.requestMs),
      ...(external ? [external] : []),
    ]);
    const excluded = new Set<string>();
    // The failure of a seller that already had the prompt: when no other seller can take it, or time
    // runs out, the client sees that failure, not a later selection's.
    let resent: FreeClientError | undefined;
    let resends = 0;
    while (!signal.aborted) {
      const winner = await dependencies
        .select(excluded, signal, {
          tools: inferenceNeedsTools(input),
          ...(model ? { model } : {}),
          conversation: dependencies.conversationKey?.(input, model),
        })
        .catch((error) => {
          const busy =
            error instanceof FreeBuyerError &&
            error.code === FREE_BUYER_CODES.BUSY;
          // Every other seller taken by requests side by side: busy, so the client may try again.
          if (resent && !busy) throw resent;
          // Local occupancy is not a network failure; retain request-local model telemetry.
          if (!signal.aborted && !busy && !resent)
            buyerUnserved(dependencies, Boolean(onDelta), model?.selection);
          throw error;
        });
      try {
        signal.throwIfAborted();
        if (excluded.has(winner.nodeId))
          throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
        excluded.add(winner.nodeId);
        const result = await attemptSelectedFree(
          input,
          dependencies,
          winner,
          signal,
          onDelta,
          undefined,
          dependencies.resendAfterSend === true &&
            resends < FREE_BUYER.maxResends,
        );
        if (result instanceof Resent) {
          resent = result.error;
          resends++;
        } else if (result) return result;
      } finally {
        dependencies.done?.(winner);
      }
    }
    throw resent ?? new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  } finally {
    release?.();
  }
}

// A conversation is known by its model, system text and first user message, which every later turn
// repeats. Only a digest is retained in routing metadata; its secret belongs to this buyer lifecycle.
// This does not protect conversation contents or the secret from a live process-memory compromise.
const SECRET_BYTES = 32;
export function createConversationKey() {
  const secret = randomBytes(SECRET_BYTES);
  return (input: FreeExecutionBuildInput, model?: RoutedModel) => {
    const system = input.messages.find((message) => message.role === 'system');
    const first = input.messages.find((message) => message.role === 'user');
    return createHmac('sha256', secret)
      .update(
        JSON.stringify([
          model?.selection ?? null,
          system?.content ?? null,
          first?.content ?? null,
        ]),
      )
      .digest('hex');
  };
}

// Returned, with the seller's failure, when the prompt was sent to a seller that failed before any visible
// text: another seller may take the whole request again.
class Resent {
  constructor(readonly error: FreeClientError) {}
}
// Failures after sending that another seller can fix: the seller dropped (the connection broke) or
// stalled (this buyer's own timeout). Both count against that seller (free-memory.ts `sellerFault`).
// An error the seller itself answered is not resent: a refusal (busy, caps) would let a seller read
// prompts it never serves without paying for it, and an engine failure may be the request's own and
// would repeat on every seller. A client that left is not a seller failure.
function resendable(error: FreeClientError) {
  return (
    !error.consumerFailure &&
    !error.remote &&
    (error.ioFailure || error.code === FREE_EXECUTION_CODES.TIMEOUT)
  );
}

// Caller owns the request admission, deadline and exclusion set; this never selects another seller.
// Undefined: the prompt was never sent, so another seller may take it.
export async function executeSelectedBuyerFree(
  input: FreeExecutionBuildInput,
  dependencies: FreeBuyerDependencies,
  winner: FreeWinner,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
  beforeExecute?: () => void,
): Promise<FreeExecutionResult | undefined> {
  const result = await attemptSelectedFree(
    input,
    dependencies,
    winner,
    signal,
    onDelta,
    beforeExecute,
    false,
  );
  return result instanceof Resent ? undefined : result;
}

// As executeSelectedBuyerFree; with `resend`, a Resent also means the prompt was sent but the seller
// failed before any visible text, so another seller may take the whole request again.
async function attemptSelectedFree(
  input: FreeExecutionBuildInput,
  dependencies: FreeBuyerDependencies,
  winner: FreeWinner,
  signal: AbortSignal,
  onDelta: ((text: string) => Promise<void>) | undefined,
  beforeExecute: (() => void) | undefined,
  resend: boolean,
): Promise<FreeExecutionResult | Resent | undefined> {
  const request = buildFreeExecutionRequest(winner.quote, input);
  const observer = buyerExecutionTelemetry(
    request,
    dependencies,
    Boolean(onDelta),
  );
  observer?.received();
  const receipt = buyerReceiptObservation(dependencies, Boolean(onDelta));
  let delivered = false;
  let visible = false;
  const emit = onDelta
    ? async (text: string) => {
        signal.throwIfAborted();
        delivered = true;
        if (text) visible = true;
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
    if (!(error instanceof FreeClientError) || signal.aborted) throw error;
    if (!error.sent && !delivered) return undefined;
    if (resend && !visible && resendable(error)) return new Resent(error);
    throw error;
  }
}
