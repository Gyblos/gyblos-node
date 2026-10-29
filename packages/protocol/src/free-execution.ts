// Parses and authenticates free execution terms; no engine, replay mutation, clock, transport or payments.
import {
  CONTROL_LIMITS,
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_MATCH_MODES,
  FREE_EXECUTION_STOP_REASONS,
  PUBLIC_RECORD_LIMITS,
  type FreeExecutionMatchMode,
} from './constants';
import type { SignedOfferV2 } from './control-types';
import {
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import {
  boundedWire,
  parseExecutionInput,
  parseExecutionResult,
} from './execution-input';
import type {
  FreeExecutionBuildInput,
  FreeExecutionFailure,
  FreeExecutionRequest,
  FreeExecutionResponse,
  FreeExecutionResult,
  FreeExecutionTrust,
} from './free-execution-types';
import {
  freeExecutionBoundary,
  FreeExecutionError,
  freeExecutionFail,
  freeExecutionText,
  rethrowFreeExecution,
} from './free-execution-validation';
import { parseOfferSignatureV2, parseOfferV2, verifyOfferV2 } from './offer-v2';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

export type {
  FreeChatMessage,
  FreeExecutionBuildInput,
  FreeExecutionDelivered,
  FreeExecutionRequest,
  FreeExecutionResponse,
  FreeExecutionResult,
  FreeExecutionStop,
  FreeExecutionTrust,
} from './free-execution-types';
export {
  FreeExecutionError,
  freeExecutionFail,
  freeExecutionStop,
} from './free-execution-validation';

function parseRequest(value: unknown): FreeExecutionRequest {
  const input = controlObject(value, [
    'version',
    'requestId',
    'quote',
    'input',
  ]);
  if (input.version !== FREE_EXECUTION.version)
    return freeExecutionFail(FREE_EXECUTION_CODES.VERSION);
  const requestId = controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes);
  const envelope = controlObject(input.quote, ['offer', 'signature']);
  const quote = {
    offer: parseOfferV2(envelope.offer),
    signature: parseOfferSignatureV2(envelope.signature),
  };
  const offered = quote.offer;
  if (
    offered.prices.inputAtomicPerMtok !== '0' ||
    offered.prices.outputAtomicPerMtok !== '0' ||
    offered.maxAtomic !== '0'
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.NOT_FREE);
  const request: FreeExecutionRequest = {
    version: FREE_EXECUTION.version,
    requestId,
    quote,
    input: parseExecutionInput(input.input, requestId, offered),
  };
  boundedWire(request, FREE_EXECUTION.requestBytes);
  return request;
}
// Structural validation is not authentication and does not consume the single-use quote.
export function parseFreeExecutionRequest(
  value: unknown,
): FreeExecutionRequest {
  return freeExecutionBoundary(() => parseRequest(value));
}
export async function verifyFreeExecutionRequest(
  value: unknown,
  trust: FreeExecutionTrust,
): Promise<FreeExecutionRequest> {
  const request = parseFreeExecutionRequest(value);
  try {
    await verifyOfferV2(request.quote, trust);
    if (request.quote.offer.buyerNodeId !== controlHex(trust.remoteNodeId))
      return freeExecutionFail(FREE_EXECUTION_CODES.PEER);
    return request;
  } catch (error) {
    return rethrowFreeExecution(error);
  }
}
export async function freeExecutionDigest(value: unknown): Promise<string> {
  const request = parseFreeExecutionRequest(value);
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(FREE_EXECUTION.requestDomain, request),
      ),
    ),
  );
}
const has = (value: unknown, key: string) =>
  !!value && typeof value === 'object' && Object.hasOwn(value, key);
// Shape only: a reason exactly with SELLER_CANNOT_CONTINUE, delivered only beside it.
function failure(value: unknown): FreeExecutionFailure {
  const hasReason = has(value, 'reason');
  const hasDelivered = has(value, 'delivered');
  const error = controlObject(value, [
    'code',
    ...(hasReason ? ['reason'] : []),
    ...(hasDelivered ? ['delivered'] : []),
  ]);
  const code = Object.values(FREE_EXECUTION_CODES).find(
    (entry) => entry === error.code,
  );
  if (!code) return freeExecutionFail();
  const cannotContinue = code === FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE;
  if (hasReason !== cannotContinue || (hasDelivered && !cannotContinue))
    return freeExecutionFail();
  if (!cannotContinue) return { code };
  const reason = Object.values(FREE_EXECUTION_STOP_REASONS).find(
    (entry) => entry === error.reason,
  );
  if (!reason) return freeExecutionFail();
  if (!hasDelivered) return { code, reason };
  const delivered = controlObject(error.delivered, ['outputTokens']);
  return {
    code,
    reason,
    delivered: {
      outputTokens: controlInteger(
        delivered.outputTokens,
        1,
        PUBLIC_RECORD_LIMITS.maxContextTokens,
      ),
    },
  };
}
export function parseFreeExecutionResponse(
  value: unknown,
): FreeExecutionResponse {
  return freeExecutionBoundary(() => {
    const failed =
      !!value && typeof value === 'object' && Object.hasOwn(value, 'error');
    const input = controlObject(value, [
      'version',
      'requestId',
      'requestDigest',
      failed ? 'error' : 'result',
    ]);
    if (input.version !== FREE_EXECUTION.version)
      return freeExecutionFail(FREE_EXECUTION_CODES.VERSION);
    const base = {
      version: FREE_EXECUTION.version,
      requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
      requestDigest: controlHex(input.requestDigest),
    };
    let response: FreeExecutionResponse;
    if (failed) {
      response = { ...base, error: failure(input.error) };
    } else response = { ...base, result: parseExecutionResult(input.result) };
    boundedWire(response, FREE_EXECUTION.responseBytes);
    return response;
  });
}
export async function matchFreeExecutionResponse(
  value: unknown,
  valueRequest: unknown,
  mode: FreeExecutionMatchMode = FREE_EXECUTION_MATCH_MODES.COMPLETE,
): Promise<FreeExecutionResult> {
  const request = parseFreeExecutionRequest(valueRequest);
  const response = parseFreeExecutionResponse(value);
  if (
    response.requestId !== request.requestId ||
    response.requestDigest !== (await freeExecutionDigest(request))
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
  if (response.error) {
    const { code, ...stop } = response.error;
    if (stop.delivered && mode === FREE_EXECUTION_MATCH_MODES.COMPLETE)
      return freeExecutionFail();
    if (stop.delivered && stop.delivered.outputTokens > request.input.maxTokens)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    throw new FreeExecutionError(code, true, stop);
  }
  if (
    response.result.usage.outputTokens > request.input.maxTokens ||
    response.result.usage.inputTokens + response.result.usage.outputTokens >
      request.quote.offer.model.contextTokens
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
  return response.result;
}

// Builds a detached request from quote-bound terms; this does not authenticate or consume the quote.
export function buildFreeExecutionRequest(
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
): FreeExecutionRequest {
  return freeExecutionBoundary(() => {
    const envelope = controlObject(quote, ['offer', 'signature']);
    const offer = parseOfferV2(envelope.offer);
    const params = controlObject(input, ['messages', 'maxTokens']);
    return parseFreeExecutionRequest({
      version: FREE_EXECUTION.version,
      requestId: offer.requestId,
      quote,
      input: {
        messages: params.messages,
        maxTokens: params.maxTokens,
        selection: offer.selection,
        reasoning: offer.reasoning,
      },
    });
  });
}
