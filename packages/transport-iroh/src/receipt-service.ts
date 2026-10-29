// Authenticates historical receipts against an injected atomic store; never executes inference or payments.
import { canonicalJson } from '@gyblos/protocol';
import {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
  RECEIPT_CHANNEL_METHODS,
} from '@gyblos/protocol/constants';
import { controlHex } from '@gyblos/protocol/control-validation';
import {
  sellerReceiptDigest,
  verifyReceipt,
  type ReceiptV1,
} from '@gyblos/protocol/receipt';
import {
  parseReceiptChannelRequest,
  ReceiptChannelError,
  receiptChannelError,
  type ConfirmedReceipt,
  type ReceiptChannelRequest,
  type ReceiptChannelResponse,
  type ReceiptLookup,
} from '@gyblos/protocol/receipt-channel';

export interface ReceiptStoreKey extends ReceiptLookup {
  buyerNodeId: string;
  sellerNodeId: string;
}
export interface ReceiptStore {
  load(
    key: ReceiptStoreKey,
    signal: AbortSignal,
  ): Promise<ReceiptV1 | undefined>;
  // Atomic compare-and-set: true only for this exact pair (including idempotent repeats), false for conflicts.
  confirm(receipt: ConfirmedReceipt, signal: AbortSignal): Promise<boolean>;
}
export interface ReceiptService {
  respond(
    value: unknown,
    peer: string,
    signal: AbortSignal,
  ): Promise<ReceiptChannelResponse>;
}
function check(signal: AbortSignal) {
  if (signal.aborted)
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CANCELLED);
}
async function receiptExchange(
  options: { store: ReceiptStore },
  local: string,
  request: ReceiptChannelRequest,
  peer: string,
  signal: AbortSignal,
): Promise<ReceiptV1> {
  const confirming = request.method === RECEIPT_CHANNEL_METHODS.CONFIRM;
  const incoming = confirming ? request.params.receipt : undefined;
  if (
    incoming &&
    (incoming.seller.record.buyerNodeId !== peer ||
      incoming.seller.record.sellerNodeId !== local)
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
  const key = {
    sellerNodeId: local,
    buyerNodeId: peer,
    ...(request.method === RECEIPT_CHANNEL_METHODS.GET
      ? request.params
      : {
          executionRequestId: request.params.receipt.seller.record.requestId,
          requestDigest: request.params.receipt.seller.record.requestDigest,
        }),
  };
  const loaded = await options.store.load(key, signal);
  check(signal);
  if (!loaded) throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.NOT_FOUND);
  const stored = await verifyReceipt(loaded);
  check(signal);
  const record = stored.seller.record;
  if (
    record.sellerNodeId !== local ||
    record.buyerNodeId !== peer ||
    record.requestId !== key.executionRequestId ||
    record.requestDigest !== key.requestDigest
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.NOT_FOUND);
  if (!incoming) return stored;
  const verified = await verifyReceipt(incoming);
  check(signal);
  if (
    !verified.buyer ||
    (await sellerReceiptDigest(verified.seller.record)) !==
      (await sellerReceiptDigest(record))
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
  check(signal);
  const result: ConfirmedReceipt = { ...verified, buyer: verified.buyer };
  if (stored.buyer) {
    if (canonicalJson(stored.buyer) !== canonicalJson(result.buyer))
      throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CONFLICT);
    return stored;
  }
  if (!(await options.store.confirm(result, signal)))
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CONFLICT);
  check(signal);
  return result;
}
export function createReceiptService(options: {
  nodeId: string;
  store: ReceiptStore;
}): ReceiptService {
  const local = controlHex(options.nodeId);

  return {
    async respond(value, peer, signal) {
      check(signal);
      const request = parseReceiptChannelRequest(value);
      try {
        const receipt = await receiptExchange(
          options,
          local,
          request,
          controlHex(peer),
          signal,
        );
        check(signal);
        return {
          version: RECEIPT_CHANNEL.version,
          requestId: request.requestId,
          result: { receipt },
        };
      } catch (error) {
        check(signal);
        return {
          version: RECEIPT_CHANNEL.version,
          requestId: request.requestId,
          error: { code: receiptChannelError(error).code },
        };
      }
    },
  };
}
