// Owns one reusable receipt connection and closes late native connects; never owns the endpoint.

import {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
  RECEIPT_CHANNEL_METHODS,
} from '@gyblos/protocol/constants';
import {
  parseReceiptChannelResponse,
  ReceiptChannelError,
  type ReceiptChannelRequest,
} from '@gyblos/protocol/receipt-channel';

import { HTTP_OVER_IROH } from './constants';
import { readControlFrame, writeControlFrame } from './control-io';
import type {
  ReceiptConnection,
  ReceiptDestination,
  ReceiptEndpoint,
} from './receipt-client-types';
import {
  checkReceiptDestination,
  checkReceiptPeer,
  verifyReceiptReply,
  type ReceiptClientOptions,
} from './receipt-client-validation';

export function createReceiptSession<Remote extends ReceiptDestination>(
  endpoint: ReceiptEndpoint<Remote>,
  remote: Remote,
  expected: string,
  options: ReceiptClientOptions,
) {
  let connection: ReceiptConnection | undefined;
  const close = () => {
    connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
    connection = undefined;
  };
  const check = (signal: AbortSignal) =>
    checkReceiptPeer(connection, expected, signal, options);
  return {
    close,
    async exchange(request: ReceiptChannelRequest, signal: AbortSignal) {
      const local = endpoint.id().toString();
      checkReceiptDestination(remote, expected, options);
      if (
        request.method === RECEIPT_CHANNEL_METHODS.CONFIRM &&
        (request.params.receipt.seller.record.buyerNodeId !== local ||
          request.params.receipt.seller.record.sellerNodeId !== expected)
      )
        throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
      if (!connection || connection.closeReason() !== null) {
        const connected = await endpoint.connect(remote, [
          ...Buffer.from(RECEIPT_CHANNEL.alpn),
        ]);
        if (signal.aborted) {
          connected.close(HTTP_OVER_IROH.streamCloseCode, []);
          check(signal);
        }
        connection = connected;
      }
      check(signal);
      const stream = await connection!.openBi();
      check(signal);
      await writeControlFrame(stream, request, RECEIPT_CHANNEL.frameBytes);
      check(signal);
      const response = parseReceiptChannelResponse(
        await readControlFrame(stream, RECEIPT_CHANNEL.frameBytes),
      );
      check(signal);
      const verified = await verifyReceiptReply(
        response,
        request,
        local,
        expected,
      );
      check(signal);
      return verified;
    },
  };
}
