// Authenticated local-buyer metadata and process-policy binding; no wallet initialization.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS, ROUTES } from '@gyblos/config';
import type { RoleConfig } from '@gyblos/node/roles';
import {
  BUYER_API,
  parseBuyerApiPolicy,
  type BuyerApiPolicy,
} from '@gyblos/protocol/buyer-api';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import type { BuyerSelectionConfig } from './selection-config';

export interface BuyerDesktopOptions {
  token?: string;
  desktopPolicy?: Pick<
    BuyerApiPolicy,
    'network' | 'mint' | 'payer' | 'maxAtomic'
  >;
}
export function configuredBuyerAccess(
  request: BuyerSelectionConfig['request'],
  role: RoleConfig | undefined,
  token: string | undefined,
): BuyerDesktopOptions {
  return {
    token,
    desktopPolicy:
      token && role?.role === P2P_ROLES.BUYER
        ? {
            network: request.network,
            mint: request.asset,
            payer: role.buyer,
            maxAtomic: request.maxAtomic,
          }
        : undefined,
  };
}
export function desktopApiPolicy(
  options: BuyerDesktopOptions,
  settings: { selection: { modelId: string }; maxTokens: number },
) {
  return options.desktopPolicy && options.token !== undefined
    ? parseBuyerApiPolicy({
        ...options.desktopPolicy,
        model: settings.selection.modelId,
        maxTokens: settings.maxTokens,
        version: BUYER_API.VERSION,
        policyId: randomUUID(),
      })
    : undefined;
}
function metadataRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: BuyerApiPolicy | undefined,
  authenticated: boolean,
) {
  if (!authenticated || request.headers.origin !== undefined) return false;
  if (
    request.method === 'GET' &&
    request.url === BUYER_API.STATUS_PATH &&
    policy
  ) {
    response
      .writeHead(HTTP_STATUS.ok, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify(policy));
    return true;
  }
  if (
    request.method === 'POST' &&
    (request.url === ROUTES.inference || request.url === BUYER_API.CHAT_PATH) &&
    (request.url === BUYER_API.CHAT_PATH ||
      request.headers['if-match'] !== undefined) &&
    (!policy || request.headers['if-match'] !== '"' + policy.policyId + '"')
  ) {
    response
      .writeHead(BUYER_API.POLICY_CHANGED_STATUS, {
        'content-type': 'application/json',
      })
      .end(
        JSON.stringify({
          error: {
            code: BUYER_API.POLICY_CHANGED_CODE,
            [BUYER_API.NEVER_SENT_FIELD]: true,
          },
        }),
      );
    return true;
  }
  return false;
}
export function createDesktopApi(
  policy: BuyerApiPolicy | undefined,
  authenticated: boolean,
) {
  return {
    handled: (request: IncomingMessage, response: ServerResponse) =>
      metadataRequest(request, response, policy, authenticated),
    accepts(request: IncomingMessage, json: boolean) {
      return (
        request.method === 'POST' &&
        request.headers.origin === undefined &&
        json &&
        (request.url === ROUTES.inference ||
          (request.url === BUYER_API.CHAT_PATH &&
            policy !== undefined &&
            authenticated))
      );
    },
  };
}
