// Canonical session requests and separate inference/RPC digests; no live policy or side effects.
import { batchTerms } from './batch-channel-terms';
import type {
  BatchChannelRequest,
  BatchExecutionRequest,
} from './batch-channel-types';
import {
  batchBill,
  batchBoundary,
  batchError,
  batchFail,
  batchVoucher,
} from './batch-channel-validation';
import { BATCH_CHANNEL, BATCH_METHODS } from './batch/constants';
import { canonicalJson } from './canonical';
import { isConversation } from './chat';
import type { SignedOfferV2 } from './control-types';
import {
  controlAddress,
  controlHex,
  controlObject,
} from './control-validation';
import { parseExecutionInput } from './execution-wire';
import { parseOfferSignatureV2, parseOfferV2 } from './offer-v2';
import { paidExecutionBoundary } from './paid-execution-validation';
import { PAID_EXECUTION_CODES } from './paid/constants';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  type SessionRequest,
} from './payment-session';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

function quoteFor(value: unknown): SignedOfferV2 {
  const row = controlObject(value, ['offer', 'signature']);
  return {
    offer: parseOfferV2(row.offer),
    signature: parseOfferSignatureV2(row.signature),
  };
}
function preparation(value: unknown, opening = false) {
  const hasTerms =
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'terms');
  const row = controlObject(value, [
    'quote',
    ...(opening ? ['payload'] : []),
    ...(hasTerms ? ['terms'] : []),
  ]);
  return { row, terms: hasTerms ? { terms: batchTerms(row.terms) } : {} };
}
function conversationInput(
  value: unknown,
  requestId: string,
  quote: SignedOfferV2,
) {
  try {
    const input = paidExecutionBoundary(() =>
      parseExecutionInput(
        value,
        requestId,
        quote.offer,
        BATCH_CHANNEL.inputBytes,
        BATCH_CHANNEL.maxMessages,
      ),
    );
    if (!isConversation(input.messages))
      return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
    if (input.maxTokens > BATCH_CHANNEL.maxOutputTokens)
      return batchFail(PAID_EXECUTION_CODES.LIMIT);
    return input;
  } catch (error) {
    throw batchError(error);
  }
}

function executionFor(value: unknown): BatchExecutionRequest {
  const row = controlObject(value, [
    'channelId',
    'requestId',
    'quote',
    'input',
  ]);
  const quote = quoteFor(row.quote);
  const requestId = controlHex(row.requestId, PAYMENT_SESSION.requestIdBytes);
  return {
    channelId: controlAddress(row.channelId),
    requestId,
    quote,
    input: conversationInput(row.input, requestId, quote),
  };
}
function parse(value: unknown): BatchChannelRequest {
  const row = controlObject(value, [
    'version',
    'requestId',
    'method',
    'params',
  ]);
  if (row.version !== BATCH_CHANNEL.version) return batchFail();
  const header = {
    version: BATCH_CHANNEL.version,
    requestId: controlHex(row.requestId, PAYMENT_SESSION.requestIdBytes),
  };
  switch (row.method) {
    case BATCH_METHODS.PREPARE: {
      const { row: params, terms } = preparation(row.params);
      return {
        ...header,
        method: row.method,
        params: { quote: quoteFor(params.quote), ...terms },
      };
    }
    case BATCH_METHODS.OPEN: {
      const { row: params, terms } = preparation(row.params, true);
      if (
        typeof params.payload !== 'string' ||
        !params.payload.length ||
        new TextEncoder().encode(params.payload).length >
          BATCH_CHANNEL.openingBytes
      )
        return batchFail(SESSION_CODES.LIMIT);
      return {
        ...header,
        method: row.method,
        params: {
          payload: params.payload,
          quote: quoteFor(params.quote),
          ...terms,
        },
      };
    }
    case BATCH_METHODS.EXECUTE:
      return {
        ...header,
        method: row.method,
        params: executionFor(row.params),
      };
    case BATCH_METHODS.APPROVE: {
      const params = controlObject(row.params, ['bill', 'voucher']);
      const bill = batchBill(params.bill);
      const voucher = batchVoucher(params.voucher);
      if (bill.cumulativeAtomic !== voucher.maxClaimableAmount)
        return batchFail(SESSION_CODES.BINDING);
      return { ...header, method: row.method, params: { bill, voucher } };
    }
    case BATCH_METHODS.SNAPSHOT:
    case BATCH_METHODS.CLOSE: {
      const params = controlObject(row.params, ['channelId']);
      return {
        ...header,
        method: row.method,
        params: { channelId: controlAddress(params.channelId) },
      };
    }
    default:
      return batchFail();
  }
}
export function parseBatchChannelRequest(value: unknown): BatchChannelRequest {
  return batchBoundary(() => {
    const request = parse(value);
    if (
      new TextEncoder().encode(canonicalJson(request)).length >
      BATCH_CHANNEL.requestBytes
    )
      return batchFail(SESSION_CODES.LIMIT);
    return request;
  });
}
async function digest(domain: string, value: unknown) {
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', signingBytes(domain, value)),
    ),
  );
}
export function batchChannelDigest(
  request: BatchChannelRequest,
): Promise<string> {
  return digest(BATCH_CHANNEL.replyDomain, parseBatchChannelRequest(request));
}
export function batchExecutionDigest(
  request: BatchExecutionRequest,
): Promise<string> {
  return batchBoundary(() =>
    digest(BATCH_CHANNEL.requestDomain, executionFor(request)),
  );
}
export async function batchSessionRequest(
  request: BatchExecutionRequest,
): Promise<SessionRequest> {
  return {
    requestId: request.requestId,
    requestDigest: await batchExecutionDigest(request),
    maxAtomic: request.quote.offer.maxAtomic,
  };
}

// Validate the supported input before any opening signature or financial transmission.
export function batchExecutionInput(
  quote: SignedOfferV2,
  input: import('./free-execution-types').FreeExecutionBuildInput,
) {
  return batchBoundary(() =>
    conversationInput(
      {
        messages: input.messages,
        maxTokens: input.maxTokens,
        selection: quote.offer.selection,
        reasoning: quote.offer.reasoning,
      },
      quote.offer.requestId,
      quote,
    ),
  );
}
export function buildBatchExecutionRequest(
  channelId: string,
  quote: SignedOfferV2,
  input: import('./free-execution-types').FreeExecutionBuildInput,
): BatchExecutionRequest {
  return batchBoundary(() =>
    executionFor({
      channelId,
      requestId: quote.offer.requestId,
      quote,
      input: batchExecutionInput(quote, input),
    }),
  );
}
