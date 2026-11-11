// Operator-only management shares the buyer listener; delegated credentials never gain management rights.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS } from '@gyblos/config';
import type { BuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  BUYER_KEY_ACTION,
  BUYER_KEY_CODES,
  BuyerApiKeyError,
  buyerKeyFail,
  parseBuyerApiKeyCommand,
} from '@gyblos/protocol/buyer-api-keys';

import { FREE_BUYER } from './constants';
import type { ChatErrorView } from './free-http';

async function command(request: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > BUYER_API_KEYS.MAX_REQUEST_BYTES) return buyerKeyFail();
    parts.push(Buffer.from(part));
  }
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
  );
  return parseBuyerApiKeyCommand(value);
}
function reply(response: ServerResponse, status: number, data: unknown) {
  response
    .writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      [FREE_BUYER.noRetryHeader]: 'false',
    })
    .end(JSON.stringify(data));
}
export async function handleBuyerApiKeys(
  request: IncomingMessage,
  response: ServerResponse,
  keys: BuyerApiKeys | undefined,
  owner: boolean,
  policy: BuyerApiPolicy | undefined,
) {
  if (request.url?.split('?')[0] !== BUYER_API_KEYS.PATH) return false;
  response.shouldKeepAlive = false;
  if (!keys || !owner || request.headers.origin !== undefined) {
    reply(response, HTTP_STATUS.forbidden, {
      error: { code: BUYER_KEY_CODES.UNAUTHORIZED },
    });
    return true;
  }
  try {
    if (request.method === 'GET')
      reply(response, HTTP_STATUS.ok, { snapshot: await keys.snapshot() });
    else if (
      request.method === 'POST' &&
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ===
        'application/json' &&
      policy &&
      request.headers['if-match'] === '"' + policy.policyId + '"'
    ) {
      const input = await command(request);
      const created =
        input.action === BUYER_KEY_ACTION.CREATE
          ? await keys.create(input.name, input.limitAtomic)
          : undefined;
      if (input.action === BUYER_KEY_ACTION.REVOKE) await keys.revoke(input.id);
      reply(response, HTTP_STATUS.ok, {
        snapshot: await keys.snapshot(),
        ...(created ? { created } : {}),
      });
    } else
      reply(response, HTTP_STATUS.badRequest, {
        error: { code: BUYER_KEY_CODES.INVALID },
      });
  } catch (error) {
    reply(response, HTTP_STATUS.badRequest, {
      error: {
        code:
          error instanceof BuyerApiKeyError
            ? error.code
            : BUYER_KEY_CODES.INVALID,
      },
    });
  }
  return true;
}

export function buyerApiKeyErrorView(
  error: unknown,
): ChatErrorView | undefined {
  if (!(error instanceof BuyerApiKeyError)) return undefined;
  return {
    code: error.code,
    status:
      error.code === BUYER_KEY_CODES.REVIEW
        ? HTTP_STATUS.serviceUnavailable
        : error.code === BUYER_KEY_CODES.REVOKED
          ? HTTP_STATUS.forbidden
          : HTTP_STATUS.badRequest,
    neverSent: error.code !== BUYER_KEY_CODES.REVIEW,
    stop: {},
    detail:
      error.code === BUYER_KEY_CODES.LIMIT
        ? 'The API key spend limit cannot cover this request.'
        : undefined,
  };
}
