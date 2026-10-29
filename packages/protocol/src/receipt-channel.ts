// Parses receipt RPC metadata and bounded signed envelopes; signatures and storage are checked by callers.
import {
  CONTROL_LIMITS,
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
  RECEIPT_CHANNEL_METHODS,
} from './constants';
import { encodeControlFrame } from './control-framing';
import { controlFail, controlHex, controlObject } from './control-validation';
import {
  receiptChannelBoundary,
  ReceiptChannelError,
} from './receipt-channel-errors';
import type {
  ReceiptChannelRequest,
  ReceiptChannelResponse,
} from './receipt-channel-types';
import { parseBuyerReceipt, parseSellerReceipt } from './receipt-parser';
import type { ReceiptV1 } from './receipt-types';

export type * from './receipt-channel-types';
export {
  ReceiptChannelError,
  receiptChannelError,
} from './receipt-channel-errors';
function envelope(value: unknown): ReceiptV1 {
  const buyer =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'buyer');
  const input = controlObject(value, ['seller', ...(buyer ? ['buyer'] : [])]);
  const signed = controlObject(input.seller, ['record', 'signature']);
  const seller = {
    record: parseSellerReceipt(signed.record),
    signature: controlHex(signed.signature, CONTROL_LIMITS.signatureBytes),
  };
  if (!buyer) return { seller };
  const other = controlObject(input.buyer, ['record', 'signature']);
  return {
    seller,
    buyer: {
      record: parseBuyerReceipt(other.record),
      signature: controlHex(other.signature, CONTROL_LIMITS.signatureBytes),
    },
  };
}
function header(value: unknown, keys: string[]) {
  const input = controlObject(value, keys);
  if (input.version !== RECEIPT_CHANNEL.version)
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.VERSION);
  return {
    input,
    requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
  };
}
export function parseReceiptChannelRequest(
  value: unknown,
): ReceiptChannelRequest {
  return receiptChannelBoundary(() => {
    encodeControlFrame(value, RECEIPT_CHANNEL.frameBytes);
    const { input, requestId } = header(value, [
      'version',
      'requestId',
      'method',
      'params',
    ]);
    if (input.method === RECEIPT_CHANNEL_METHODS.GET) {
      const params = controlObject(input.params, [
        'executionRequestId',
        'requestDigest',
      ]);
      return {
        version: RECEIPT_CHANNEL.version,
        requestId,
        method: input.method,
        params: {
          executionRequestId: controlHex(
            params.executionRequestId,
            CONTROL_LIMITS.requestIdBytes,
          ),
          requestDigest: controlHex(params.requestDigest),
        },
      };
    }
    if (input.method !== RECEIPT_CHANNEL_METHODS.CONFIRM) return controlFail();
    const params = controlObject(input.params, ['receipt']);
    const receipt = envelope(params.receipt);
    if (!receipt.buyer) return controlFail();
    return {
      version: RECEIPT_CHANNEL.version,
      requestId,
      method: input.method,
      params: { receipt: { ...receipt, buyer: receipt.buyer } },
    };
  });
}
export function parseReceiptChannelResponse(
  value: unknown,
): ReceiptChannelResponse {
  return receiptChannelBoundary(() => {
    encodeControlFrame(value, RECEIPT_CHANNEL.frameBytes);
    const success =
      !!value && typeof value === 'object' && Object.hasOwn(value, 'result');
    const { input, requestId } = header(value, [
      'version',
      'requestId',
      success ? 'result' : 'error',
    ]);
    if (success) {
      const result = controlObject(input.result, ['receipt']);
      return {
        version: RECEIPT_CHANNEL.version,
        requestId,
        result: { receipt: envelope(result.receipt) },
      };
    }
    const error = controlObject(input.error, ['code']);
    const code = Object.values(RECEIPT_CHANNEL_CODES).find(
      (code) => code === error.code,
    );
    if (!code) return controlFail();
    return { version: RECEIPT_CHANNEL.version, requestId, error: { code } };
  });
}
