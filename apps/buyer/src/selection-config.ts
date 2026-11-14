// Reads an opt-in static candidate list and buyer policy, never remote discovery or seller claims.
// Endpoint identities are operator trust inputs; signed public records remain separately verified.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { homeLayout, type HomeEnvironment } from '@gyblos/config/home';
import {
  parseBuyerRoutingPolicy,
  type BuyerRoutingPolicy,
} from '@gyblos/core/buyer-routing';
import { SELLER_BADGES, SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  selectSellers,
  type SellerRequest,
} from '@gyblos/core/seller-selection';
import { assertRoleHome } from '@gyblos/node/home';
import {
  parseBuyerSessionPolicy,
  type BuyerSessionPolicy,
} from '@gyblos/node/session-policy';
import {
  DATA_RETENTION,
  P2P_ROLES,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';
import {
  controlAddress,
  controlArray,
  controlAtomic,
  controlHex,
  controlInteger,
  controlNetwork,
  controlObject,
  controlReasoning,
  controlText,
} from '@gyblos/protocol/control-validation';
import { parseTokenPricesV2 } from '@gyblos/protocol/pricing-v2';
import { parsePublicV2 } from '@gyblos/protocol/public-v2';

import { BUYER_SELECTION, BUYER_SELECTION_CODES } from './constants';
import {
  parseBuyerDiscoveryConfig,
  type BuyerDiscoveryConfig,
} from './discovery-config';
import {
  parseBuyerIdentityConfig,
  type BuyerIdentityConfig,
} from './identity-config';
import {
  findModelRoute,
  parseModelRoutes,
  routedRequest,
  type ModelRoute,
} from './model-routes';

export class BuyerSelectionError extends Error {
  constructor(
    readonly code: (typeof BUYER_SELECTION_CODES)[keyof typeof BUYER_SELECTION_CODES],
  ) {
    super(code);
    this.name = 'BuyerSelectionError';
  }
}
export interface StaticControlSeller {
  owner: string;
  nodeId: string;
  relayUrl: string | null;
  directAddresses: string[];
  withdrawal?: SignedPublicV2;
  manualTrust?: boolean;
}
export const BUYER_FAILOVER = { SAFE: 'safe', NEVER: 'never' } as const;
export type BuyerFailover =
  (typeof BUYER_FAILOVER)[keyof typeof BUYER_FAILOVER];
export interface BuyerSelectionConfig {
  routing?: BuyerRoutingPolicy;
  session?: BuyerSessionPolicy;
  request: SellerRequest;
  sellers: StaticControlSeller[];
  pinnedNodeId?: string;
  discovery?: BuyerDiscoveryConfig;
  identity?: BuyerIdentityConfig;
  // Milliseconds quotes may race; when absent, the caller's windowMs, else BUYER_SELECTION.windowMs.
  quoteWindowMs?: number;
  // The models the endpoint serves by name; when absent, request.selection is the one model.
  models?: ModelRoute[];
  // "safe" (the default): a free request whose seller failed after the prompt was sent, before any
  // visible text, goes to another seller, so the prompt may reach two sellers. "never" keeps it on one.
  failover?: BuyerFailover;
  // Set per request, never read from selection.json: the seller that served this conversation before.
  previousSeller?: string;
}
function parseRequest(value: unknown): SellerRequest {
  const row = controlObject(value, [
    'selection',
    'reasoning',
    'lowestReasoning',
    'network',
    'asset',
    'maxTokens',
    'maxAtomic',
    'priceCeilings',
    'minimumBadge',
    'retention',
  ]);
  const selection = controlObject(row.selection, [
    'modelId',
    'variant',
    'quantization',
  ]);
  // Until a real badge source exists, config cannot elevate checkability.
  if (row.minimumBadge !== SELLER_BADGES.DECLARED_USAGE)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  const retention = controlArray(
    row.retention,
    Object.keys(DATA_RETENTION).length,
  ).map((value) => {
    for (const item of Object.values(DATA_RETENTION))
      if (value === item) return item;
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  });
  return {
    selection: {
      modelId: controlText(selection.modelId),
      variant:
        selection.variant === null ? null : controlText(selection.variant),
      quantization:
        selection.quantization === null
          ? null
          : controlText(selection.quantization),
    },
    reasoning: controlReasoning(row.reasoning),
    lowestReasoning:
      row.lowestReasoning === null
        ? null
        : controlReasoning(row.lowestReasoning),
    network: controlNetwork(row.network),
    asset: controlAddress(row.asset),
    maxTokens: controlInteger(row.maxTokens, 1),
    maxAtomic: controlAtomic(row.maxAtomic),
    priceCeilings: parseTokenPricesV2(row.priceCeilings),
    minimumBadge: SELLER_BADGES.DECLARED_USAGE,
    retention,
  };
}
function parseStaticSeller(value: unknown): StaticControlSeller {
  const seller = optionalObject(
    value,
    ['owner', 'nodeId', 'relayUrl', 'directAddresses'],
    ['withdrawal', 'manualTrust'],
  );
  const result: StaticControlSeller = {
    owner: controlAddress(seller.owner),
    nodeId: controlHex(seller.nodeId),
    relayUrl:
      seller.relayUrl === null
        ? null
        : controlText(seller.relayUrl, BUYER_SELECTION.endpointCharacters),
    directAddresses: controlArray(
      seller.directAddresses,
      BUYER_SELECTION.directAddresses,
    ).map((value) =>
      controlText(value, BUYER_SELECTION.directAddressCharacters),
    ),
  };
  if (seller.manualTrust !== undefined) {
    if (typeof seller.manualTrust !== 'boolean')
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    result.manualTrust = seller.manualTrust;
  }
  // Full signature, shape and exact-catalog validation is done before selection, not here.
  if (seller.withdrawal !== undefined) {
    const signed = controlObject(seller.withdrawal, ['record', 'signature']);
    result.withdrawal = {
      record: parseWithdrawal(signed.record),
      signature: controlText(
        signed.signature,
        BUYER_SELECTION.signatureHexCharacters,
      ),
    };
  }
  return result;
}
export function parseBuyerSelectionConfig(
  value: unknown,
): BuyerSelectionConfig {
  try {
    const row = optionalObject(
      value,
      ['request', 'sellers'],
      [
        'pinnedNodeId',
        'discovery',
        'identity',
        'quoteWindowMs',
        'session',
        'routing',
        'models',
        'failover',
      ],
    );
    const request = parseRequest(row.request);
    const models =
      row.models === undefined
        ? undefined
        : parseModelRoutes(row.models, request);
    // buyer:chat asks for the request's own model, so a list must serve it by name.
    if (models && !findModelRoute(models, request.selection.modelId))
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    // Every model's request must be one selection accepts, as the single request always had to be.
    for (const model of models ?? [undefined])
      validRequest(routedRequest(request, model));
    const sellers = controlArray(row.sellers, BUYER_SELECTION.maxSellers).map(
      parseStaticSeller,
    );
    const discovery =
      row.discovery === undefined
        ? undefined
        : parseBuyerDiscoveryConfig(row.discovery);
    // Open discovery trusts no index claim: every seller it adds must prove a registered identity, so it
    // needs `identity`, and it may then start with no configured seller at all.
    if (
      (discovery?.open && row.identity === undefined) ||
      (!sellers.length && !discovery?.open) ||
      new Set(sellers.map((item) => item.nodeId)).size !== sellers.length
    )
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    return {
      request,
      ...(models ? { models } : {}),
      ...(row.routing === undefined
        ? {}
        : { routing: parseBuyerRoutingPolicy(row.routing) }),
      ...(row.session === undefined
        ? {}
        : { session: parseBuyerSessionPolicy(row.session) }),
      sellers,
      ...(row.identity === undefined
        ? {}
        : { identity: parseBuyerIdentityConfig(row.identity) }),
      ...(discovery ? { discovery } : {}),
      ...(row.pinnedNodeId === undefined
        ? {}
        : { pinnedNodeId: controlHex(row.pinnedNodeId) }),
      ...(row.failover === undefined
        ? {}
        : { failover: parseFailover(row.failover) }),
      ...(row.quoteWindowMs === undefined
        ? {}
        : {
            quoteWindowMs: controlInteger(
              row.quoteWindowMs,
              BUYER_SELECTION.minWindowMs,
              BUYER_SELECTION.maxWindowMs,
            ),
          }),
    };
  } catch {
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  }
}

function parseFailover(value: unknown): BuyerFailover {
  for (const option of Object.values(BUYER_FAILOVER))
    if (value === option) return option;
  throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
}

function validRequest(request: SellerRequest) {
  const validation = selectSellers({
    request,
    sellers: [],
    stats: new Map(),
    now: 0,
    random: () => 0,
  });
  if (!validation.ok && validation.code === SELLER_SELECTION_CODES.INVALID)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
}
function parseWithdrawal(value: unknown) {
  const record = parsePublicV2(value);
  if (record.kind !== PUBLIC_RECORD_KINDS.WITHDRAWAL)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  return record;
}
export async function loadBuyerSelectionConfig(environment: HomeEnvironment) {
  await assertRoleHome(P2P_ROLES.BUYER, environment);
  const path = join(
    homeLayout(environment).roles.buyer,
    BUYER_SELECTION.configFile,
  );
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > BUYER_SELECTION.maxConfigBytes
    )
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parseBuyerSelectionConfig(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  }
}

function optionalObject(
  value: unknown,
  required: string[],
  optional: string[],
) {
  const present =
    value !== null && typeof value === 'object'
      ? optional.filter((key) => Object.hasOwn(value, key))
      : [];
  return controlObject(value, [...required, ...present]);
}
