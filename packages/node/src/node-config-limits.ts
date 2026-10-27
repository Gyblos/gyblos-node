// gyblos.toml [limits]: the seller capacity values an operator may tune, each between 1 and a hard
// ceiling, checked against the built-in value of any total it is part of. Request concurrency stays
// fixed because the managed engine serves one generation at a time.
import { TRANSPORT_LIMITS, type TransportLimits } from '@gyblos/config';
import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';

import { NODE_CONFIG_ISSUE_CODES, SELLER_LIMIT_CEILINGS } from './constants.js';
import {
  integer,
  optional,
  table,
  unknownKeys,
  withoutUndefined,
  type ConfigPath,
  type IssueList,
} from './node-config-fields.js';

export interface NodeLimits {
  maxConnections?: number;
  maxPeerConnections?: number;
  requestsPerMinute?: number;
  globalRequestsPerMinute?: number;
  maxFreeBuyersPerDay?: number;
}

export interface SellerLimits {
  transport: TransportLimits;
  maxFreeBuyers: number;
}

const LIMIT_KEYS = {
  max_connections: 'maxConnections',
  max_peer_connections: 'maxPeerConnections',
  requests_per_minute: 'requestsPerMinute',
  global_requests_per_minute: 'globalRequestsPerMinute',
  max_free_buyers_per_day: 'maxFreeBuyersPerDay',
} as const satisfies Record<string, keyof NodeLimits>;

function limit(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
  ceiling: number,
) {
  const parsed = integer(value, path, issues);
  if (parsed === undefined) return undefined;
  if (parsed < 1n || parsed > BigInt(ceiling))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_LIMIT, path);
  return Number(parsed);
}

// The values the seller serves with: the file's [limits] over the built-in defaults.
export function sellerLimits(limits: NodeLimits = {}): SellerLimits {
  return {
    transport: {
      ...TRANSPORT_LIMITS,
      maxConnections: limits.maxConnections ?? TRANSPORT_LIMITS.maxConnections,
      maxPeerConnections:
        limits.maxPeerConnections ?? TRANSPORT_LIMITS.maxPeerConnections,
      requestsPerWindow:
        limits.requestsPerMinute ?? TRANSPORT_LIMITS.requestsPerWindow,
      globalRequestsPerWindow:
        limits.globalRequestsPerMinute ??
        TRANSPORT_LIMITS.globalRequestsPerWindow,
    },
    maxFreeBuyers:
      limits.maxFreeBuyersPerDay ?? FREE_EXECUTION_ADMISSION.maxBuyers,
  };
}

export function readLimits(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): NodeLimits | undefined {
  const section = table(value, path, issues);
  if (!section) return undefined;
  const read: NodeLimits = {};
  for (const [key, field] of Object.entries(LIMIT_KEYS) as [
    keyof typeof LIMIT_KEYS,
    keyof NodeLimits,
  ][])
    read[field] = optional(section, key, path, (item, at) =>
      limit(item, at, issues, SELLER_LIMIT_CEILINGS[field]),
    );
  unknownKeys(section, path, Object.keys(LIMIT_KEYS), issues);
  const effective = sellerLimits(read).transport;
  // A part larger than its whole could never be reached; name the part, since it is what was set.
  if (effective.maxPeerConnections > effective.maxConnections)
    issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_LIMIT, [
      ...path,
      'max_peer_connections',
    ]);
  if (effective.requestsPerWindow > effective.globalRequestsPerWindow)
    issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_LIMIT, [
      ...path,
      'requests_per_minute',
    ]);
  return withoutUndefined(read);
}
