// gyblos.toml [limits]: the seller capacity values an operator may tune, each between 1 and a hard
// ceiling, and together within the global request budget. Request concurrency and per-buyer
// connections stay fixed: the managed engine runs one generation at a time, so each buyer has one
// request in flight and the seller at most two (one running, one queued).
import {
  ATTEMPTS_PER_REQUEST,
  CONNECTIONS_PER_REQUEST,
  TRANSPORT_LIMITS,
  type TransportLimits,
} from '@gyblos/config';
import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';

import { NODE_CONFIG_ISSUE_CODES, SELLER_LIMIT_CEILINGS } from './constants';
import {
  integer,
  optional,
  table,
  unknownKeys,
  withoutUndefined,
  type ConfigPath,
  type IssueList,
} from './node-config-fields';

export interface NodeLimits {
  maxConnections?: number;
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
  requests_per_minute: 'requestsPerMinute',
  global_requests_per_minute: 'globalRequestsPerMinute',
  max_free_buyers_per_day: 'maxFreeBuyersPerDay',
} as const satisfies Record<string, keyof NodeLimits>;
// The key blamed when the budget does not fit: the first one the file sets, totals first.
const BUDGET_KEYS = [
  'global_requests_per_minute',
  'requests_per_minute',
  'max_connections',
] as const;

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

// The values the seller serves with: the file's [limits] over the built-in defaults. "Per minute" holds
// because the rate window (TRANSPORT_LIMITS.rateWindowMs) is fixed at one minute.
export function sellerLimits(limits: NodeLimits = {}): SellerLimits {
  const requestsPerWindow =
    limits.requestsPerMinute ?? TRANSPORT_LIMITS.requestsPerWindow;
  const globalRequestsPerWindow =
    limits.globalRequestsPerMinute ?? TRANSPORT_LIMITS.globalRequestsPerWindow;
  return {
    transport: {
      ...TRANSPORT_LIMITS,
      maxConnections: limits.maxConnections ?? TRANSPORT_LIMITS.maxConnections,
      requestsPerWindow,
      globalRequestsPerWindow,
      // Connection attempts scale with what one request costs (see CONNECTIONS_PER_REQUEST), so they
      // never cap a raised request rate below what was configured, nor drop below the built-in values.
      connectionAttemptsPerPeer: Math.max(
        TRANSPORT_LIMITS.connectionAttemptsPerPeer,
        requestsPerWindow * CONNECTIONS_PER_REQUEST,
      ),
      connectionAttemptsPerSource: Math.max(
        TRANSPORT_LIMITS.connectionAttemptsPerSource,
        requestsPerWindow * ATTEMPTS_PER_REQUEST,
      ),
      connectionAttemptsPerWindow: Math.max(
        TRANSPORT_LIMITS.connectionAttemptsPerWindow,
        globalRequestsPerWindow * ATTEMPTS_PER_REQUEST,
      ),
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
  const mark = issues.mark();
  const read: NodeLimits = {};
  for (const [key, field] of Object.entries(LIMIT_KEYS) as [
    keyof typeof LIMIT_KEYS,
    keyof NodeLimits,
  ][])
    read[field] = optional(section, key, path, (item, at) =>
      limit(item, at, issues, SELLER_LIMIT_CEILINGS[field]),
    );
  unknownKeys(section, path, Object.keys(LIMIT_KEYS), issues);
  if (!issues.cleanSince(mark)) return undefined;
  // Every connected buyer reserves its per-minute requests from the global budget, so the budget must
  // cover a full pool; otherwise later buyers are refused and one buyer can hold the whole budget.
  const effective = sellerLimits(read).transport;
  if (
    effective.maxConnections * effective.requestsPerWindow >
    effective.globalRequestsPerWindow
  )
    issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_LIMIT, [
      ...path,
      BUDGET_KEYS.find((key) => section[key] !== undefined)!,
    ]);
  return withoutUndefined(read);
}
