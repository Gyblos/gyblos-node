// Host validation precedes credential classification; only the operator may manage delegated keys.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS } from '@gyblos/config';
import type { BuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';

import { handleBuyerApiKeys } from './api-key-http';
import { FREE_BUYER, PAID_BUYER, PAID_BUYER_CODES } from './constants';
import { buyerBearer } from './paid-token';

export async function acceptBuyerApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authorize: ((request: IncomingMessage) => boolean) | undefined,
  apiKeys: BuyerApiKeys | undefined,
  policy: BuyerApiPolicy | undefined,
) {
  const caller = acceptBuyerCaller(request, response, authorize, apiKeys);
  if (
    !caller ||
    (await handleBuyerApiKeys(request, response, apiKeys, caller.owner, policy))
  )
    return undefined;
  return caller;
}

export function acceptBuyerCaller(
  request: IncomingMessage,
  response: ServerResponse,
  authorize: ((request: IncomingMessage) => boolean) | undefined,
  apiKeys: BuyerApiKeys | undefined,
) {
  if (!acceptLoopbackHost(request, response)) return undefined;
  const owner = authorize?.(request) ?? true;
  const keyId = owner ? undefined : apiKeys?.authenticate(buyerBearer(request));
  if (owner || keyId !== undefined) return { owner, keyId };
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
  return undefined;
}
