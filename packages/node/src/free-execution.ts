// Composes free quote authentication, admission and one pinned-engine generation for one free offer, and
// prepares the seller's offer behind the free router on the seller's ledger. No payments, facilitator,
// No direct config/file/payment access; an injected publisher handles private receipt persistence.
import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import {
  FreeExecutionAdmission,
  type FreeSellerLedger,
} from '@gyblos/core/free-admission';
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_METERING_MODES,
  ENGINE_ERROR_CODES,
  ENGINE_ERROR_STOP_REASON,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  OFFER_PRICING_KINDS,
  PUBLIC_RECORD_KINDS,
  type EngineKind,
  type FreeExecutionStopReason,
} from '@gyblos/protocol/constants';
import type {
  ModelSelection,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import {
  EngineError,
  type Engine,
  type EngineCapabilities,
  type EngineDescription,
  type EngineResult,
} from '@gyblos/protocol/engine';
import {
  freeExecutionFail as fail,
  freeExecutionDigest,
  FreeExecutionError,
  freeExecutionStop,
  parseFreeExecutionRequest,
  parseFreeExecutionResponse,
  verifyFreeExecutionRequest,
  type FreeExecutionRequest,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';

import { createFreeStreamOutput } from './free-execution-stream';
import type { FreeMeter } from './free-meter';
import { createSellerFreeRouter } from './free-router';
import {
  finishSellerTelemetry,
  sellerExecutionTelemetry,
} from './free-telemetry';
import {
  sellerReceiptObservation,
  type SellerReceiptOptions,
} from './receipt-seller';
import type { FreeSellerOffer, SellerCatalogOffer } from './seller-offer';

export interface SellerFreeExecutionOptions {
  receipts?: SellerReceiptOptions;
  telemetry?: {
    sink: TelemetrySink;
    engineKind: EngineKind;
    now?: () => number;
  };
  owner: string;
  nodeId: string;
  offer: FreeSellerOffer;
  selection: ModelSelection;
  model: EngineDescription;
  capabilities: EngineCapabilities;
  engine: Engine;
  // Recounted with the model's tokenizer, or declared by the engine's provider.
  meter: FreeMeter;
  readiness: () => QuoteReadiness;
  now: () => number;
  // The seller's one ledger (single use, concurrency, distinct buyers), shared by all its free offers.
  ledger: FreeSellerLedger;
}
function checkSignal(signal: AbortSignal) {
  if (signal.aborted) return fail(FREE_EXECUTION_CODES.CANCELLED);
}
function supportedInput(
  request: FreeExecutionRequest,
  options: SellerFreeExecutionOptions,
) {
  const offer = request.quote.offer;
  if (
    canonicalJson(offer.selection) !== canonicalJson(options.selection) ||
    canonicalJson(offer.model) !== canonicalJson(options.model) ||
    canonicalJson(offer.capabilities) !== canonicalJson(options.capabilities) ||
    !options.offer.reasoning.includes(offer.reasoning)
  )
    return fail(FREE_EXECUTION_CODES.UNSUPPORTED);
  if (
    request.input.messages.length !== 1 ||
    request.input.messages[0]!.role !== FREE_CHAT_ROLES.USER
  )
    return fail(FREE_EXECUTION_CODES.UNSUPPORTED);
  if (request.input.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return request.input.messages[0]!.content;
}
function ready(options: SellerFreeExecutionOptions) {
  const state = options.readiness();
  const now = options.now();
  if (state.busy) return fail(FREE_EXECUTION_CODES.BUSY);
  if (state.observedAt > now || state.validUntil <= now)
    return fail(FREE_EXECUTION_CODES.ENGINE);
}
export function createSellerFreeExecution(options: SellerFreeExecutionOptions) {
  const admission = new FreeExecutionAdmission(
    options.offer.caps,
    options.ledger,
  );
  return {
    respond: (value: unknown, peer: string, signal: AbortSignal) =>
      respond(value, peer, signal, options, admission),
    stream: (
      value: unknown,
      peer: string,
      signal: AbortSignal,
      onDelta: (text: string) => Promise<void>,
    ) => respond(value, peer, signal, options, admission, onDelta),
  };
}
function freeInputTokens(
  request: FreeExecutionRequest,
  prompt: string,
  options: SellerFreeExecutionOptions,
) {
  const inputTokens = options.meter.input(prompt);
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens + request.input.maxTokens > options.model.contextTokens
  )
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return inputTokens;
}
function observedOutput(
  deliver: ((text: string) => Promise<void>) | undefined,
  receipt: ReturnType<typeof sellerReceiptObservation>,
  observer: ReturnType<typeof sellerExecutionTelemetry>,
  signal: AbortSignal,
) {
  return deliver
    ? async (text: string) => {
        await deliver(text);
        receipt?.text(text);
        if (!signal.aborted && text) observer?.firstToken();
      }
    : undefined;
}
function executionFailure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return { code: FREE_EXECUTION_CODES.CANCELLED };
  if (error instanceof FreeExecutionError)
    return { code: error.code, ...freeExecutionStop(error) };
  return { code: FREE_EXECUTION_CODES.ENGINE };
}
async function respond(
  value: unknown,
  peer: string,
  signal: AbortSignal,
  options: SellerFreeExecutionOptions,
  admission: FreeExecutionAdmission,
  onDelta?: (text: string) => Promise<void>,
): Promise<FreeExecutionResponse> {
  const request = parseFreeExecutionRequest(value);
  const header = {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
  };
  let observer: ReturnType<typeof sellerExecutionTelemetry>;
  let started = false;
  let receipt: ReturnType<typeof sellerReceiptObservation>;
  try {
    checkSignal(signal);
    const verifiedAt = options.now();
    await verifyFreeExecutionRequest(request, {
      owner: options.owner,
      nodeId: options.nodeId,
      remoteNodeId: peer,
      now: verifiedAt,
    });
    checkSignal(signal);
    observer = sellerExecutionTelemetry(request, options, Boolean(onDelta));
    const prompt = supportedInput(request, options);
    receipt = sellerReceiptObservation(
      request,
      header.requestDigest,
      options.meter,
      options.receipts,
      Boolean(onDelta),
      verifiedAt,
    );
    ready(options);
    const inputTokens = freeInputTokens(request, prompt, options);
    const lease = admission.enter(request, inputTokens, options.now());
    let actual: number | undefined;
    let completed: FreeExecutionResponse | undefined;
    try {
      checkSignal(signal);
      started = true;
      receipt?.started(inputTokens);
      const response = await generateResponse(
        request,
        prompt,
        inputTokens,
        header,
        options,
        signal,
        observedOutput(onDelta, receipt, observer, signal),
      );
      if (!response.result) return fail(FREE_EXECUTION_CODES.INTERNAL);
      // A declared count never returns reserved tokens: the provider's word alone cannot stretch the caps.
      if (options.meter.refunds)
        actual =
          response.result.usage.inputTokens +
          response.result.usage.outputTokens;
      finishSellerTelemetry(observer, request, response, started);
      completed = response;
      return response;
    } finally {
      lease.complete(actual);
      if (completed) receipt?.finish(completed);
    }
  } catch (error) {
    const response: FreeExecutionResponse = {
      ...header,
      error: executionFailure(error, signal),
    };
    finishSellerTelemetry(observer, request, response, started);
    receipt?.finish(response);
    return response;
  }
}
// An engine that stops after admission tells the buyer why and, on a stream, how much it delivered,
// as the buyer's verifier bounds it: at least one token for non-empty text, never more than its UTF-8
// bytes or maxTokens.
function cannotContinue(
  error: EngineError,
  meter: FreeMeter,
  maxTokens: number,
  deliveredText = '',
): never {
  const reason: FreeExecutionStopReason | undefined =
    ENGINE_ERROR_STOP_REASON[error.code];
  // A code outside the catalog is not a uniform engine failure; it stays a generic engine refusal.
  if (!reason) throw error;
  throw new FreeExecutionError(
    FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    false,
    {
      reason,
      ...(deliveredText
        ? {
            delivered: {
              outputTokens: meter.delivered(deliveredText, maxTokens),
            },
          }
        : {}),
    },
  );
}

// One offer and its signed catalog, prepared by the caller; no configuration is read again.
export function prepareSellerFreeExecution(
  options: Omit<SellerFreeExecutionOptions, 'selection' | 'offer'> & {
    offer: SellerCatalogOffer;
    catalog: SignedPublicV2;
  },
) {
  if (options.offer.kind !== OFFER_PRICING_KINDS.FREE) return undefined;
  const record = options.catalog.record;
  if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG)
    return fail(FREE_EXECUTION_CODES.INTERNAL);
  const listing = record.models.find(
    (model) => model.modelId === options.offer.modelId,
  );
  if (!listing) return fail(FREE_EXECUTION_CODES.INTERNAL);
  const selection = {
    modelId: listing.modelId,
    variant: listing.variant,
    quantization: listing.quantization,
  };
  const service = createSellerFreeExecution({
    ...options,
    offer: options.offer,
    selection,
  });
  // One offer, for lab acceptance and tests; the daemon serves its offer set through free-offers.
  return createSellerFreeRouter(() => [{ selection, service }]);
}

async function generateResponse(
  request: FreeExecutionRequest,
  prompt: string,
  inputTokens: number,
  header: Pick<
    FreeExecutionResponse,
    'version' | 'requestId' | 'requestDigest'
  >,
  options: SellerFreeExecutionOptions,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
): Promise<FreeExecutionResponse> {
  const streaming = onDelta
    ? createFreeStreamOutput(
        request,
        header,
        options.meter,
        inputTokens,
        signal,
        onDelta,
      )
    : undefined;
  let output: EngineResult;
  try {
    output = await options.engine.generate({
      prompt,
      maxTokens: request.input.maxTokens,
      signal,
      ...(streaming ? { onText: streaming.onText } : {}),
    });
    checkSignal(signal);
    streaming?.complete(output.text);
  } catch (error) {
    if (error instanceof EngineError && !signal.aborted)
      return cannotContinue(
        error,
        options.meter,
        request.input.maxTokens,
        streaming?.delivered(),
      );
    throw error;
  } finally {
    streaming?.stop();
  }
  const preliminary = parseFreeExecutionResponse({
    ...header,
    result: {
      text: output.text,
      usage: { inputTokens, outputTokens: 0 },
      finishReason: output.finishReason,
    },
  });
  if (!preliminary.result) return fail(FREE_EXECUTION_CODES.INTERNAL);
  const usage = options.meter.usage(
    preliminary.result.text,
    output.usage,
    inputTokens,
  );
  // The buyer's own bounds. A recounted count beyond them is a limit (admission already prevents it);
  // an implausible or out-of-bounds declared count is the provider's invalid response.
  if (
    !usage ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.outputTokens > request.input.maxTokens ||
    usage.inputTokens + usage.outputTokens > options.model.contextTokens
  ) {
    if (options.meter.mode === CONTROL_METERING_MODES.RECOUNTED)
      return fail(FREE_EXECUTION_CODES.LIMIT);
    return cannotContinue(
      new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE),
      options.meter,
      request.input.maxTokens,
      streaming?.delivered(),
    );
  }
  return parseFreeExecutionResponse({
    ...header,
    result: { ...preliminary.result, usage },
  });
}
