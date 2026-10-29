// Checks peer routing and receipt response correlation; owner trust remains an independent caller policy.

import { canonicalJson } from '@gyblos/protocol';
import {
  RECEIPT_CHANNEL_CODES,
  RECEIPT_CHANNEL_METHODS,
} from '@gyblos/protocol/constants';
import { verifyReceipt } from '@gyblos/protocol/receipt';
import {
  ReceiptChannelError,
  type ReceiptChannelRequest,
  type ReceiptChannelResponse,
} from '@gyblos/protocol/receipt-channel';

import { TRANSPORT_ROUTES } from './constants';
import { selectedRoute } from './paths';
import type {
  ReceiptConnection,
  ReceiptDestination,
} from './receipt-client-types';

export interface ReceiptClientOptions {
  queryMs?: number;
  relayOnly?: boolean;
  relayAllowed?: (origin: string) => boolean;
}
export function checkReceiptPeer(
  connection: ReceiptConnection | undefined,
  expected: string,
  signal: AbortSignal,
  options: ReceiptClientOptions,
) {
  if (signal.aborted)
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CANCELLED);
  if (
    connection &&
    (connection.remoteId().toString() !== expected ||
      (options.relayOnly &&
        selectedRoute(connection) !== TRANSPORT_ROUTES.RELAY))
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
}
export function checkReceiptDestination(
  remote: ReceiptDestination,
  expected: string,
  options: ReceiptClientOptions,
) {
  const relay = remote.relayUrl();
  if (
    remote.id().toString() !== expected ||
    (relay && !options.relayAllowed?.(relay)) ||
    (options.relayOnly && !relay)
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
}
export async function verifyReceiptReply(
  response: ReceiptChannelResponse,
  request: ReceiptChannelRequest,
  local: string,
  remote: string,
) {
  if (response.requestId !== request.requestId)
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
  if (response.error) throw new ReceiptChannelError(response.error.code, true);
  const receipt = await verifyReceipt(response.result.receipt);
  const actual = receipt.seller.record;
  const lookup =
    request.method === RECEIPT_CHANNEL_METHODS.GET
      ? request.params
      : {
          executionRequestId: request.params.receipt.seller.record.requestId,
          requestDigest: request.params.receipt.seller.record.requestDigest,
        };
  if (
    actual.sellerNodeId !== remote ||
    actual.buyerNodeId !== local ||
    actual.requestId !== lookup.executionRequestId ||
    actual.requestDigest !== lookup.requestDigest
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
  if (
    request.method === RECEIPT_CHANNEL_METHODS.CONFIRM &&
    canonicalJson(receipt) !== canonicalJson(request.params.receipt)
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
  return response;
}
