// Canonical session requests and separate inference/RPC digests; no live policy or side effects.
import type {
  BatchChannelRequest,
  BatchExecutionRequest,
} from './batch-channel-types';
import {
  batchBill,
  batchBoundary,
  batchFail,
  batchVoucher,
} from './batch-channel-validation';
import { BATCH_CHANNEL, BATCH_METHODS } from './batch/constants';
import { canonicalJson } from './canonical';
import type { SignedOfferV2 } from './control-types';
import {
  controlAddress,
  controlHex,
  controlObject,
} from './control-validation';
import { parseExecutionInput } from './execution-wire';
import { parseOfferSignatureV2, parseOfferV2 } from './offer-v2';
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
    input: parseExecutionInput(row.input, requestId, quote.offer),
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
    case BATCH_METHODS.OPEN: {
      const params = controlObject(row.params, ['payload', 'quote']);
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
        params: { payload: params.payload, quote: quoteFor(params.quote) },
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
