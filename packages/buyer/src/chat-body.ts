// Admits the local caller and reads one request body as UTF-8 JSON within the free channel's request bound;
// a body cut off or too large is refused before any of it is parsed.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS } from '@gyblos/config';
import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';

import {
  FREE_BUYER,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  PAID_BUYER,
  PAID_BUYER_CODES,
} from './constants';
import { FreeBuyerError, invalidChat } from './free-chat-error';

export async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > FREE_EXECUTION.requestBytes)
      throw new FreeBuyerError(FREE_BUYER_CODES.TOO_LARGE);
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw invalidChat(null, FREE_CHAT_DETAILS.json);
  }
}

// A loopback Host, then in paid mode the bearer token: loopback is not authentication, and any local
// process could otherwise spend. The refusal comes before the body is read, and the connection closes
// rather than draining an unread body.
export function acceptCaller(
  request: IncomingMessage,
  response: ServerResponse,
  authorize?: (request: IncomingMessage) => boolean,
) {
  if (!acceptLoopbackHost(request, response)) return false;
  if (!authorize || authorize(request)) return true;
  response.shouldKeepAlive = false;
  const code = PAID_BUYER_CODES.UNAUTHORIZED;
  response
    .writeHead(HTTP_STATUS.unauthorized, {
      'content-type': 'application/json',
      'www-authenticate': PAID_BUYER.authScheme,
      [FREE_BUYER.noRetryHeader]: 'false',
    })
    .end(
      JSON.stringify({
        error: { message: code, type: FREE_BUYER.errorType, param: null, code },
      }),
    );
  return false;
}
