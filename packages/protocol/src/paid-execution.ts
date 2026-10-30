// Parses and authenticates paid execution terms: the free input bound to a priced quote plus the
// payment authorization, and terminals that report the charge and its settlement. No engine,
// payment adapter, replay mutation, clock or transport.
import { CONTROL_LIMITS, PUBLIC_RECORD_LIMITS } from './constants';
import type { SignedOfferV2 } from './control-types';
import {
  controlAtomic,
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import {
  boundedWire,
  hasField,
  parseExecutionFailure,
  parseExecutionInput,
  parseExecutionResult,
} from './execution-wire';
import type { FreeExecutionBuildInput } from './free-execution-types';
import { parseOfferSignatureV2, parseOfferV2, verifyOfferV2 } from './offer-v2';
import type {
  PaidCharge,
  PaidExecutionRequest,
  PaidExecutionResponse,
  PaidExecutionTrust,
  PaidPayment,
} from './paid-execution-types';
import {
  paidExecutionBoundary,
  paidExecutionFail,
  rethrowPaidExecution,
} from './paid-execution-validation';
import {
  PAID_DELIVERED_CODES,
  PAID_DEPOSITED_CODES,
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_REFUSAL_CODES,
} from './paid/constants';
import type { PaymentAuthorization, PaymentSettlement } from './payment';
import { PAYMENT_BINDING } from './payments/constants';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

export type * from './paid-execution-types';
export {
  PaidExecutionError,
  paidExecutionFail,
} from './paid-execution-validation';

// Standard padded base64: whole four-character groups, the last possibly padded.
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function identifier(value: unknown): string {
  return typeof value === 'string' && PAID_EXECUTION.identifier.test(value)
    ? value
    : paidExecutionFail();
}

function payload(value: unknown): string {
  if (typeof value !== 'string') return paidExecutionFail();
  if (value.length > PAID_EXECUTION.payloadBytes)
    return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
  return value.length > 0 && BASE64.test(value) ? value : paidExecutionFail();
}

function authorization(value: unknown): PaymentAuthorization {
  const input = controlObject(value, [
    'channelId',
    'payer',
    'requestDigest',
    'maxAtomic',
    'payload',
  ]);
  return {
    channelId: identifier(input.channelId),
    payer: identifier(input.payer),
    requestDigest: controlHex(input.requestDigest),
    maxAtomic: controlAtomic(input.maxAtomic),
    payload: payload(input.payload),
  };
}

function parseRequest(value: unknown): PaidExecutionRequest {
  const input = controlObject(value, [
    'version',
    'requestId',
    'quote',
    'input',
    'payment',
  ]);
  if (input.version !== PAID_EXECUTION.version)
    return paidExecutionFail(PAID_EXECUTION_CODES.VERSION);
  const requestId = controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes);
  const envelope = controlObject(input.quote, ['offer', 'signature']);
  const quote = {
    offer: parseOfferV2(envelope.offer),
    signature: parseOfferSignatureV2(envelope.signature),
  };
  const offered = quote.offer;
  if (offered.maxAtomic === '0')
    return paidExecutionFail(PAID_EXECUTION_CODES.NOT_PAID);
  const payment = authorization(input.payment);
  if (
    payment.requestDigest !== offered.requestDigest ||
    payment.maxAtomic !== offered.maxAtomic ||
    payment.payer !== offered.buyer
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
  const request: PaidExecutionRequest = {
    version: PAID_EXECUTION.version,
    requestId,
    quote,
    input: parseExecutionInput(input.input, requestId, offered),
    payment,
  };
  boundedWire(request, PAID_EXECUTION.requestBytes);
  return request;
}

// Structural validation is not authentication and neither consumes the quote nor admits payment.
export function parsePaidExecutionRequest(
  value: unknown,
): PaidExecutionRequest {
  return paidExecutionBoundary(() => parseRequest(value));
}

export async function verifyPaidExecutionRequest(
  value: unknown,
  trust: PaidExecutionTrust,
): Promise<PaidExecutionRequest> {
  const request = parsePaidExecutionRequest(value);
  try {
    await verifyOfferV2(request.quote, trust);
    if (request.quote.offer.buyerNodeId !== controlHex(trust.remoteNodeId))
      return paidExecutionFail(PAID_EXECUTION_CODES.PEER);
    return request;
  } catch (error) {
    return rethrowPaidExecution(error);
  }
}

export async function paidExecutionDigest(value: unknown): Promise<string> {
  const request = parsePaidExecutionRequest(value);
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(PAID_EXECUTION.requestDomain, request),
      ),
    ),
  );
}

// Builds a detached request from quote-bound terms and a payment authorization; this neither
// authenticates the quote nor signs, deposits or journals anything.
export function buildPaidExecutionRequest(
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  payment: PaymentAuthorization,
): PaidExecutionRequest {
  return paidExecutionBoundary(() => {
    const offer = parseOfferV2(
      controlObject(quote, ['offer', 'signature']).offer,
    );
    const params = controlObject(input, ['messages', 'maxTokens']);
    return parsePaidExecutionRequest({
      version: PAID_EXECUTION.version,
      requestId: offer.requestId,
      quote,
      input: {
        messages: params.messages,
        maxTokens: params.maxTokens,
        selection: offer.selection,
        reasoning: offer.reasoning,
      },
      payment,
    });
  });
}

function tokens(value: unknown): number {
  return controlInteger(value, 0, PUBLIC_RECORD_LIMITS.maxContextTokens);
}

function charge(value: unknown): PaidCharge {
  const input = controlObject(value, [
    'inputTokens',
    'outputTokens',
    'chargedAtomic',
  ]);
  return {
    inputTokens: tokens(input.inputTokens),
    outputTokens: tokens(input.outputTokens),
    chargedAtomic: controlAtomic(input.chargedAtomic),
  };
}

function settlement(value: unknown, charged: string): PaymentSettlement {
  const input = controlObject(value, [
    'channelId',
    'chargedAtomic',
    'refundedAtomic',
    'sellerAtomic',
    'feeAtomic',
    'transaction',
  ]);
  const parsed = {
    channelId: identifier(input.channelId),
    chargedAtomic: controlAtomic(input.chargedAtomic),
    refundedAtomic: controlAtomic(input.refundedAtomic),
    sellerAtomic: controlAtomic(input.sellerAtomic),
    feeAtomic: controlAtomic(input.feeAtomic),
    transaction: identifier(input.transaction),
  };
  const dust =
    BigInt(charged) - BigInt(parsed.sellerAtomic) - BigInt(parsed.feeAtomic);
  if (
    parsed.chargedAtomic !== charged ||
    dust < 0n ||
    dust > BigInt(PAYMENT_BINDING.shareDustAtomic)
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
  return parsed;
}

function payment(value: unknown, charged: string): PaidPayment {
  if (hasField(value, 'settlement'))
    return {
      settlement: settlement(
        controlObject(value, ['settlement']).settlement,
        charged,
      ),
    };
  if (hasField(value, 'lapsed')) {
    const lapsed = controlObject(controlObject(value, ['lapsed']).lapsed, [
      'channelId',
    ]);
    return { lapsed: { channelId: identifier(lapsed.channelId) } };
  }
  const pending = controlObject(controlObject(value, ['pending']).pending, [
    'channelId',
    'chargedAtomic',
    'transaction',
  ]);
  if (controlAtomic(pending.chargedAtomic) !== charged)
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
  return {
    pending: {
      channelId: identifier(pending.channelId),
      chargedAtomic: charged,
      transaction:
        pending.transaction === null ? null : identifier(pending.transaction),
    },
  };
}

const FAILURE_RULES = {
  codes: Object.values(PAID_EXECUTION_CODES),
  reasonCode: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  deliveredCodes: PAID_DELIVERED_CODES,
  fail: () => paidExecutionFail(),
};

// The charge must describe what the terminal reports: the result's usage, the delivered output of
// a stop, or nothing at all (charged 0) when no output was delivered.
function chargeMatches(
  response: PaidExecutionResponse,
  charged: PaidCharge,
): boolean {
  if (response.result)
    return (
      charged.inputTokens === response.result.usage.inputTokens &&
      charged.outputTokens === response.result.usage.outputTokens
    );
  const delivered = response.error.delivered?.outputTokens ?? 0;
  return delivered
    ? charged.outputTokens === delivered
    : charged.outputTokens === 0 && charged.chargedAtomic === '0';
}

function parseResponse(value: unknown): PaidExecutionResponse {
  const failed = hasField(value, 'error');
  const paid = hasField(value, 'charge') || hasField(value, 'payment');
  const input = controlObject(value, [
    'version',
    'requestId',
    'requestDigest',
    failed ? 'error' : 'result',
    ...(paid ? ['charge', 'payment'] : []),
  ]);
  if (input.version !== PAID_EXECUTION.version)
    return paidExecutionFail(PAID_EXECUTION_CODES.VERSION);
  // A delivered result always follows a deposit.
  if (!failed && !paid) return paidExecutionFail();
  const base = {
    version: PAID_EXECUTION.version,
    requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
    requestDigest: controlHex(input.requestDigest),
  };
  const outcome = failed
    ? { error: parseExecutionFailure(input.error, FAILURE_RULES) }
    : { result: parseExecutionResult(input.result) };
  // Refusals precede any deposit; deposited-only stops always follow one.
  const code = outcome.error?.code;
  if (
    (paid && code && PAID_REFUSAL_CODES.includes(code)) ||
    (!paid && code && PAID_DEPOSITED_CODES.includes(code))
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
  if (!paid) return { ...base, ...outcome };
  const charged = charge(input.charge);
  const response = {
    ...base,
    ...outcome,
    charge: charged,
    payment: payment(input.payment, charged.chargedAtomic),
  };
  if (!chargeMatches(response, charged))
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
  return response;
}

export function parsePaidExecutionResponse(
  value: unknown,
): PaidExecutionResponse {
  return paidExecutionBoundary(() => {
    const response = parseResponse(value);
    boundedWire(response, PAID_EXECUTION.responseBytes);
    return response;
  });
}
