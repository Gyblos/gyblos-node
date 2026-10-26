// Parses and authenticates free execution terms; no engine, replay mutation, clock, transport or payments.
import { canonicalJson } from './canonical.js';
import {
  CONTROL_LIMITS,
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  PUBLIC_RECORD_LIMITS,
  type FreeChatRole,
} from './constants.js';
import { parseModelSelection } from './control-requests.js';
import type { SignedOfferV2 } from './control-types.js';
import {
  controlArray,
  controlHex,
  controlInteger,
  controlObject,
  controlReasoning,
} from './control-validation.js';
import type {
  FreeChatMessage,
  FreeExecutionBuildInput,
  FreeExecutionRequest,
  FreeExecutionResponse,
  FreeExecutionResult,
  FreeExecutionTrust,
} from './free-execution-types.js';
import {
  freeExecutionBoundary,
  FreeExecutionError,
  freeExecutionFail,
  freeExecutionText,
  rethrowFreeExecution,
} from './free-execution-validation.js';
import {
  parseOfferSignatureV2,
  parseOfferV2,
  verifyOfferV2,
} from './offer-v2.js';
import { bytesHex } from './public-validation.js';
import { signingBytes } from './signing.js';

export type {
  FreeChatMessage,
  FreeExecutionBuildInput,
  FreeExecutionRequest,
  FreeExecutionResponse,
  FreeExecutionResult,
  FreeExecutionTrust,
} from './free-execution-types.js';
export {
  FreeExecutionError,
  freeExecutionFail,
} from './free-execution-validation.js';

function role(value: unknown): FreeChatRole {
  for (const accepted of Object.values(FREE_CHAT_ROLES))
    if (value === accepted) return accepted;
  return freeExecutionFail();
}
function messages(value: unknown) {
  const entries = controlArray(value, FREE_EXECUTION.maxMessages);
  if (!entries.length) return freeExecutionFail();
  let bytes = 0;
  return entries.map((entry) => {
    const input = controlObject(entry, ['role', 'content']);
    const content = freeExecutionText(input.content, FREE_EXECUTION.inputBytes);
    bytes += new TextEncoder().encode(content).length;
    if (bytes > FREE_EXECUTION.inputBytes)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    return { role: role(input.role), content };
  });
}
function boundedWire(value: unknown, maximum: number) {
  if (new TextEncoder().encode(canonicalJson(value)).length > maximum)
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
}
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
  const params = controlObject(input.input, [
    'messages',
    'selection',
    'reasoning',
    'maxTokens',
  ]);
  const selection = parseModelSelection(params.selection);
  const reasoning = controlReasoning(params.reasoning);
  if (
    requestId !== offered.requestId ||
    canonicalJson(selection) !== canonicalJson(offered.selection) ||
    reasoning !== offered.reasoning
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
  const maxTokens = controlInteger(
    params.maxTokens,
    1,
    PUBLIC_RECORD_LIMITS.maxContextTokens,
  );
  if (maxTokens > offered.maxTokens || maxTokens > offered.model.contextTokens)
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
  const request: FreeExecutionRequest = {
    version: FREE_EXECUTION.version,
    requestId,
    quote,
    input: {
      messages: messages(params.messages),
      selection,
      reasoning,
      maxTokens,
    },
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
function result(value: unknown): FreeExecutionResult {
  const input = controlObject(value, ['text', 'usage', 'finishReason']);
  const usage = controlObject(input.usage, ['inputTokens', 'outputTokens']);
  if (
    input.finishReason !== ENGINE_DONE_REASONS.STOP &&
    input.finishReason !== ENGINE_DONE_REASONS.LENGTH
  )
    return freeExecutionFail();
  return {
    text: freeExecutionText(input.text, FREE_EXECUTION.outputBytes),
    usage: {
      inputTokens: controlInteger(
        usage.inputTokens,
        0,
        PUBLIC_RECORD_LIMITS.maxContextTokens,
      ),
      outputTokens: controlInteger(
        usage.outputTokens,
        0,
        PUBLIC_RECORD_LIMITS.maxContextTokens,
      ),
    },
    finishReason: input.finishReason,
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
      const error = controlObject(input.error, ['code']);
      const code = Object.values(FREE_EXECUTION_CODES).find(
        (entry) => entry === error.code,
      );
      if (!code) return freeExecutionFail();
      response = { ...base, error: { code } };
    } else response = { ...base, result: result(input.result) };
    boundedWire(response, FREE_EXECUTION.responseBytes);
    return response;
  });
}
export async function matchFreeExecutionResponse(
  value: unknown,
  valueRequest: unknown,
): Promise<FreeExecutionResult> {
  const request = parseFreeExecutionRequest(valueRequest);
  const response = parseFreeExecutionResponse(value);
  if (
    response.requestId !== request.requestId ||
    response.requestDigest !== (await freeExecutionDigest(request))
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
  if (response.error) throw new FreeExecutionError(response.error.code, true);
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
