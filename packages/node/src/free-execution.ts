// Composes free quote authentication, admission and one pinned-engine generation for one free offer, and
// prepares the seller's offer behind the free router on the seller's ledger. No payments, facilitator,
// v1, config reads, files or journals are reachable from this service.
import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import {
  FreeExecutionAdmission,
  type FreeSellerLedger,
} from '@gyblos/core/free-admission';
import { canonicalJson } from '@gyblos/protocol';
import {
  ENGINE_ERROR_STOP_REASON,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  OFFER_PRICING_KINDS,
  PUBLIC_RECORD_KINDS,
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
  type RecountTokenizer,
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

import { createFreeStreamOutput } from './free-execution-stream';
import { createSellerFreeRouter } from './free-router';
import type { FreeSellerOffer, SellerCatalogOffer } from './seller-offer';

export interface SellerFreeExecutionOptions {
  owner: string;
  nodeId: string;
  offer: FreeSellerOffer;
  selection: ModelSelection;
  model: EngineDescription;
  capabilities: EngineCapabilities;
  engine: Engine;
  tokenizer: RecountTokenizer;
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
  try {
    checkSignal(signal);
    await verifyFreeExecutionRequest(request, {
      owner: options.owner,
      nodeId: options.nodeId,
      remoteNodeId: peer,
      now: options.now(),
    });
    checkSignal(signal);
    const prompt = supportedInput(request, options);
    ready(options);
    const inputTokens = options.tokenizer.input(prompt);
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      inputTokens + request.input.maxTokens > options.model.contextTokens
    )
      return fail(FREE_EXECUTION_CODES.LIMIT);
    const lease = admission.enter(request, inputTokens, options.now());
    let actual: number | undefined;
    try {
      checkSignal(signal);
      const response = await generateResponse(
        request,
        prompt,
        inputTokens,
        header,
        options,
        signal,
        onDelta,
      );
      if (!response.result) return fail(FREE_EXECUTION_CODES.INTERNAL);
      actual =
        response.result.usage.inputTokens + response.result.usage.outputTokens;
      return response;
    } finally {
      lease.complete(actual);
    }
  } catch (error) {
    if (signal.aborted)
      return { ...header, error: { code: FREE_EXECUTION_CODES.CANCELLED } };
    if (!(error instanceof FreeExecutionError))
      return { ...header, error: { code: FREE_EXECUTION_CODES.ENGINE } };
    return {
      ...header,
      error: { code: error.code, ...freeExecutionStop(error) },
    };
  }
}
// An engine that stops after admission tells the buyer why and, on a stream, how much it delivered.
// Delivered text was already recounted within maxTokens before delivery. The report mirrors the buyer's
// verifier: at least one token for non-empty text and never more than its UTF-8 bytes, which a
// normalising tokenizer could otherwise exceed.
function cannotContinue(
  error: EngineError,
  tokenizer: RecountTokenizer,
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
              outputTokens: Math.min(
                Math.max(1, tokenizer.count(deliveredText)),
                new TextEncoder().encode(deliveredText).length,
              ),
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
        options.tokenizer,
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
      return cannotContinue(error, options.tokenizer, streaming?.delivered());
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
  const outputTokens = options.tokenizer.count(preliminary.result.text);
  if (
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    outputTokens > request.input.maxTokens
  )
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return parseFreeExecutionResponse({
    ...header,
    result: {
      ...preliminary.result,
      usage: { inputTokens, outputTokens },
    },
  });
}
