// Bounded local request parsing and static responses; no receipt-read route, CORS, redirects or external fetches.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS } from '@gyblos/config';
import {
  RECEIPT_COLLECTOR_CODES,
  RECEIPT_COLLECTOR_LIMITS,
} from '@gyblos/core/constants';
import { ReceiptCollectorError } from '@gyblos/core/receipt-collector';

import { LOCAL_COLLECTOR_CODES, type LocalCollectorCode } from './constants';
import { collectorFail, LocalCollectorError } from './errors';

export function collectorReply(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
) {
  if (response.destroyed || response.writableEnded) return;
  response.once('finish', () => request.destroy());
  response
    .writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'close',
    })
    .end(JSON.stringify(value));
}
export async function collectorBody(
  request: IncomingMessage,
  signal: AbortSignal,
) {
  if (
    request.headers['content-type'] !== 'application/json' ||
    request.headers['content-encoding'] !== undefined
  )
    return collectorFail(LOCAL_COLLECTOR_CODES.INVALID);
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > RECEIPT_COLLECTOR_LIMITS.bytes)
  )
    return collectorFail(LOCAL_COLLECTOR_CODES.LIMIT);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    if (signal.aborted) return collectorFail(LOCAL_COLLECTOR_CODES.TIMEOUT);
    bytes += part.length;
    if (bytes > RECEIPT_COLLECTOR_LIMITS.bytes)
      return collectorFail(LOCAL_COLLECTOR_CODES.LIMIT);
    chunks.push(Buffer.from(part));
  }
  if (signal.aborted) return collectorFail(LOCAL_COLLECTOR_CODES.TIMEOUT);
  return Buffer.concat(chunks);
}
export function collectorFailure(
  request: IncomingMessage,
  response: ServerResponse,
  error: unknown,
) {
  let code: LocalCollectorCode = LOCAL_COLLECTOR_CODES.STORAGE;
  let status: number = HTTP_STATUS.serviceUnavailable;
  if (error instanceof LocalCollectorError) {
    code = error.code;
    if (code === LOCAL_COLLECTOR_CODES.UNAUTHORIZED)
      status = HTTP_STATUS.unauthorized;
    if (code === LOCAL_COLLECTOR_CODES.FORBIDDEN)
      status = HTTP_STATUS.forbidden;
    if (code === LOCAL_COLLECTOR_CODES.INVALID) status = HTTP_STATUS.badRequest;
    if (code === LOCAL_COLLECTOR_CODES.LIMIT)
      status = HTTP_STATUS.payloadTooLarge;
    if (code === LOCAL_COLLECTOR_CODES.BUSY)
      status = HTTP_STATUS.tooManyRequests;
    if (code === LOCAL_COLLECTOR_CODES.TIMEOUT)
      status = HTTP_STATUS.gatewayTimeout;
  } else if (error instanceof ReceiptCollectorError) {
    if (
      error.code === RECEIPT_COLLECTOR_CODES.LIMIT ||
      error.code === RECEIPT_COLLECTOR_CODES.BUSY
    ) {
      code = LOCAL_COLLECTOR_CODES.BUSY;
      status = HTTP_STATUS.tooManyRequests;
    } else if (
      error.code !== RECEIPT_COLLECTOR_CODES.STORAGE &&
      error.code !== RECEIPT_COLLECTOR_CODES.CANCELLED
    ) {
      code = LOCAL_COLLECTOR_CODES.INVALID;
      status = HTTP_STATUS.badRequest;
    }
  }
  collectorReply(request, response, status, { code });
}
