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

import { CHAT_ROUTES } from './constants';
import type { BuyerSelectionConfig } from './selection-config';

export interface BuyerDesktopOptions {
  token?: string;
  reconcilePool?: () => Promise<void>;
  preparePaidChat?: () => Promise<void>;
  desktopPolicy?: Pick<
    BuyerApiPolicy,
    | 'network'
    | 'mint'
    | 'payer'
    | 'maxAtomic'
    | 'depositAtomic'
    | 'lifetimeMs'
    | 'totalDepositAtomic'
    | 'paidAuto'
    | 'autoPrices'
    | 'autoRoutes'
  >;
}
export function configuredBuyerAccess(
  request: BuyerSelectionConfig['request'],
  role: RoleConfig | undefined,
  token: string | undefined,
  session?: BuyerSelectionConfig['session'],
  config?: Pick<
    BuyerSelectionConfig,
    'discovery' | 'identity' | 'models' | 'sellers' | 'pinnedNodeId'
  >,
): BuyerDesktopOptions {
  return {
    token,
    desktopPolicy:
      token && role?.role === P2P_ROLES.BUYER
        ? {
            ...(session && {
              depositAtomic: session.depositAtomic,
              lifetimeMs: session.lifetimeMs,
              ...(session.totalDepositAtomic !== undefined && {
                totalDepositAtomic: session.totalDepositAtomic,
              }),
            }),
            ...(config?.discovery?.open &&
              config.identity &&
              !config.pinnedNodeId &&
              !config.sellers.length && {
                autoPrices: request.priceCeilings,
                autoRoutes: config.models?.map(
                  ({ id, selection, maxTokens }) => ({
                    id,
                    modelId: selection.modelId,
                    maxTokens,
                  }),
                ) ?? [
                  {
                    id: request.selection.modelId,
                    modelId: request.selection.modelId,
                    maxTokens: request.maxTokens,
                  },
                ],
                ...(config.discovery.paidAuto && { paidAuto: true }),
              }),
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
  preparePaidChat: boolean,
) {
  if (!authenticated || request.headers.origin !== undefined) return false;
  const path = request.url?.split('?')[0];
  if (request.method === 'GET' && path === BUYER_API.STATUS_PATH && policy) {
    response
      .writeHead(HTTP_STATUS.ok, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(preparePaidChat && {
          [BUYER_API.PAID_PREPARATION_HEADER]: BUYER_API.PAID_PREPARATION_PATH,
        }),
      })
      .end(JSON.stringify(policy));
    return true;
  }
  if (
    request.method === 'POST' &&
    (path === ROUTES.inference ||
      path === CHAT_ROUTES.messages ||
      path === BUYER_API.CHAT_PATH ||
      path === BUYER_API.CHANNEL_CHAT_PATH) &&
    (path === BUYER_API.CHANNEL_CHAT_PATH ||
      path === BUYER_API.CHAT_PATH ||
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
// This route accepts no prompt or seller and cannot select an offer, open a channel or run inference.
async function prepareRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: BuyerApiPolicy | undefined,
  owner: boolean,
  prepare: (() => Promise<void>) | undefined,
) {
  response.setHeader('cache-control', 'no-store');
  if (
    !owner ||
    request.headers.origin !== undefined ||
    !policy ||
    (policy.maxAtomic === '0' &&
      request.url !== BUYER_API.RECONCILE_POOL_PATH) ||
    !prepare
  ) {
    response.writeHead(HTTP_STATUS.forbidden).end();
    return;
  }
  if (
    request.method !== 'POST' ||
    request.headers['transfer-encoding'] !== undefined ||
    Number(request.headers['content-length'] ?? 0) !== 0
  ) {
    response.shouldKeepAlive = false;
    response.writeHead(HTTP_STATUS.badRequest).end();
    return;
  }
  if (request.headers['if-match'] !== '"' + policy.policyId + '"') {
    response.writeHead(BUYER_API.POLICY_CHANGED_STATUS).end();
    return;
  }
  try {
    await prepare();
    if (!response.destroyed) response.writeHead(HTTP_STATUS.noContent).end();
  } catch {
    if (!response.destroyed)
      response.writeHead(HTTP_STATUS.serviceUnavailable).end();
  }
}
export function createDesktopApi(
  policy: BuyerApiPolicy | undefined,
  authenticated: boolean,
  preparePaidChat?: () => Promise<void>,
  reconcilePool?: () => Promise<void>,
) {
  return {
    async handled(
      request: IncomingMessage,
      response: ServerResponse,
      owner: boolean,
    ) {
      const reconcile = request.url === BUYER_API.RECONCILE_POOL_PATH;
      if (reconcile || request.url === BUYER_API.PAID_PREPARATION_PATH) {
        await prepareRequest(
          request,
          response,
          policy,
          authenticated && owner,
          reconcile ? reconcilePool : preparePaidChat,
        );
        return true;
      }
      return metadataRequest(
        request,
        response,
        policy,
        authenticated,
        !!preparePaidChat && owner,
      );
    },
    accepts(request: IncomingMessage, json: boolean) {
      const path = request.url?.split('?')[0];
      return (
        request.method === 'POST' &&
        request.headers.origin === undefined &&
        json &&
        (path === ROUTES.inference ||
          ((path === BUYER_API.CHAT_PATH ||
            path === BUYER_API.CHANNEL_CHAT_PATH) &&
            policy !== undefined &&
            authenticated))
      );
    },
  };
}
