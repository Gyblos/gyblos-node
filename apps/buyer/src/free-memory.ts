// One buyer remembers recent conversation sellers in memory and execution failures in local statistics.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import type { FreeWinner } from './free-execution';
import type { PreparedSelection } from './free-selection';
import {
  recordExecutionFailure,
  type LocalSellerStats,
} from './selection-stats';

// The seller each recent conversation went to, so its next turn can go back while that seller's prompt
// cache may be warm. A choice is kept only once that seller has answered, and dropped when it fails. Keys
// are digests, in memory only and bounded; the least recent is forgotten first.
export function stickySellers(limit: number) {
  const sellers = new Map<string, string>();
  // The conversation each selected seller is now serving, until it answers or fails.
  const serving = new Map<string, string>();
  const keep = (key: string, nodeId: string) => {
    sellers.delete(key);
    sellers.set(key, nodeId);
    if (sellers.size > limit)
      sellers.delete(sellers.keys().next().value as string);
  };
  return {
    get: (key: string) => sellers.get(key),
    chose(key: string, nodeId: string) {
      serving.set(nodeId, key);
    },
    served(nodeId: string) {
      const key = serving.get(nodeId);
      serving.delete(nodeId);
      if (key) keep(key, nodeId);
    },
    forget(nodeId: string) {
      const key = serving.get(nodeId);
      serving.delete(nodeId);
      if (key && sellers.get(key) === nodeId) sellers.delete(key);
    },
  };
}

// Failures that are the seller's: one it reported (its engine or generation failed), or, once the prompt
// was sent, a stalled or out-of-protocol answer. The buyer's own refusals before sending (an expired quote,
// relay rules, its request) and its own faults are not held against a seller.
const REPORTED: ReadonlySet<string> = new Set([
  FREE_EXECUTION_CODES.ENGINE,
  FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  FREE_EXECUTION_CODES.TIMEOUT,
  FREE_EXECUTION_CODES.INTERNAL,
]);
const AFTER_SENDING: ReadonlySet<string> = new Set([
  FREE_EXECUTION_CODES.TIMEOUT,
  FREE_EXECUTION_CODES.INVALID,
  FREE_EXECUTION_CODES.SIGNATURE,
  FREE_EXECUTION_CODES.BINDING,
]);
export const sellerFault = (error: unknown) =>
  error instanceof FreeClientError &&
  !error.consumerFailure &&
  (error.remote
    ? REPORTED.has(error.code)
    : error.sent && (error.ioFailure || AFTER_SENDING.has(error.code)));
// A failed execution lowers its seller's weight; saving the record is best effort, never the request's
// failure.
export async function recordFault(
  stats: {
    rows: Map<string, LocalSellerStats>;
    save(): Promise<void>;
  },
  sticky: ReturnType<typeof stickySellers>,
  nodeId: string,
) {
  sticky.forget(nodeId);
  recordExecutionFailure(stats.rows, nodeId);
  await stats.save().catch(() => undefined);
}

// Stats of sellers found only in the index stay in memory: selection-stats.json holds the configured
// sellers alone (at most BUYER_SELECTION.maxSellers rows), and a restart starts them fresh.
const UNSAVED = new WeakMap<object, Map<string, LocalSellerStats>>();
export const statsFor = (
  prepared: PreparedSelection,
  configured: ReadonlyMap<string, unknown>,
  winner: FreeWinner,
) =>
  configured.has(winner.nodeId)
    ? prepared.stats
    : { rows: unsavedStats(prepared), save: async () => {} };
export function unsavedStats(prepared: PreparedSelection) {
  let rows = UNSAVED.get(prepared.stats);
  if (!rows) UNSAVED.set(prepared.stats, (rows = new Map()));
  return rows;
}
