// Reads an opt-in static candidate list and buyer policy, never remote discovery or seller claims.
// Endpoint identities are operator trust inputs; signed public records remain separately verified.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { homeLayout, type HomeEnvironment } from '@gyblos/config/home';
import { SELLER_BADGES, SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  selectSellers,
  type SellerRequest,
} from '@gyblos/core/seller-selection';
import { P2P_ROLES } from '@gyblos/node/constants';
import { assertRoleHome } from '@gyblos/node/home';
import {
  DATA_RETENTION,
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

import { BUYER_SELECTION, BUYER_SELECTION_CODES } from './constants.js';
import {
  parseBuyerDiscoveryConfig,
  type BuyerDiscoveryConfig,
} from './discovery-config.js';
import { parseBuyerIdentityConfig, type BuyerIdentityConfig } from './identity-config.js';

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
export interface BuyerSelectionConfig {
  request: SellerRequest;
  sellers: StaticControlSeller[];
  pinnedNodeId?: string;
  discovery?: BuyerDiscoveryConfig;
  identity?: BuyerIdentityConfig;
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
export function parseBuyerSelectionConfig(
  value: unknown,
): BuyerSelectionConfig {
  try {
    const row = optionalObject(
      value,
      ['request', 'sellers'],
      ['pinnedNodeId', 'discovery', 'identity'],
    );
    const request = parseRequest(row.request);
    const validation = selectSellers({
      request,
      sellers: [],
      stats: new Map(),
      now: 0,
      random: () => 0,
    });
    if (!validation.ok && validation.code === SELLER_SELECTION_CODES.INVALID)
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    const sellers = controlArray(row.sellers, BUYER_SELECTION.maxSellers).map(
      (value) => {
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
              : controlText(
                  seller.relayUrl,
                  BUYER_SELECTION.endpointCharacters,
                ),
          directAddresses: controlArray(
            seller.directAddresses,
            BUYER_SELECTION.directAddresses,
          ).map((value) =>
            controlText(value, BUYER_SELECTION.directAddressCharacters),
          ),
        };
        if (seller.manualTrust !== undefined) {
          if (typeof seller.manualTrust !== 'boolean') throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
          result.manualTrust = seller.manualTrust;
        }
        // Full signature, shape and exact-catalog validation is done before selection, not here.
        if (seller.withdrawal !== undefined) {
          const signed = controlObject(seller.withdrawal, [
            'record',
            'signature',
          ]);
          result.withdrawal = {
            record: parseWithdrawal(signed.record),
            signature: controlText(
              signed.signature,
              BUYER_SELECTION.signatureHexCharacters,
            ),
          };
        }
        return result;
      },
    );
    if (
      !sellers.length ||
      new Set(sellers.map((item) => item.nodeId)).size !== sellers.length
    )
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    return {
      request,
      sellers,
      ...(row.identity === undefined ? {} : { identity: parseBuyerIdentityConfig(row.identity) }),
      ...(row.discovery === undefined
        ? {}
        : { discovery: parseBuyerDiscoveryConfig(row.discovery) }),
      ...(row.pinnedNodeId === undefined
        ? {}
        : { pinnedNodeId: controlHex(row.pinnedNodeId) }),
    };
  } catch {
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  }
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
