// Owns buyer-local failure streaks and cooldowns; streak counters live only in memory.
// Never changes the strict persisted selection-stats.json format.
import { BUYER_SELECTION } from './constants';
import type { LocalSellerStats } from './selection-stats';
import {
  reportSellerFailure,
  type SellerFailure,
  type SellerFailureReporter,
} from './seller-failures';

export interface SellerBackoff {
  // Records one more failure in a row and returns how long this cooldown lasts.
  failed(nodeId: string): number;
  succeeded(nodeId: string): void;
}

export interface SellerBackoffMemory extends SellerBackoff {
  fork(): { backoff: SellerBackoff; commit(): void };
}

export function createSellerBackoff(): SellerBackoffMemory {
  const streaks = new Map<string, number>();
  const backoff = backoffFrom(streaks);
  return {
    ...backoff,
    fork: () => forkBackoff(backoff, backoffFrom(new Map(streaks))),
  };
}

function backoffFrom(streaks: Map<string, number>): SellerBackoff {
  return {
    failed(nodeId) {
      const streak = Math.min(
        (streaks.get(nodeId) ?? 0) + 1,
        BUYER_SELECTION.maxBackoffSteps,
      );
      if (
        !streaks.has(nodeId) &&
        streaks.size >= BUYER_SELECTION.maxCachedSellers
      )
        streaks.clear();
      streaks.set(nodeId, streak);
      return Math.min(
        BUYER_SELECTION.cooldownMs * 2 ** (streak - 1),
        BUYER_SELECTION.maxCooldownMs,
      );
    },
    succeeded(nodeId) {
      streaks.delete(nodeId);
    },
  };
}

// A request previews its own streak changes. Only accepted selections replay them into the live
// buyer memory; replaying changes rather than replacing the map preserves other accepted selections.
function forkBackoff(live: SellerBackoff, local: SellerBackoff) {
  const outcomes: { nodeId: string; success: boolean }[] = [];
  return {
    backoff: {
      failed(nodeId: string) {
        outcomes.push({ nodeId, success: false });
        return local.failed(nodeId);
      },
      succeeded(nodeId: string) {
        outcomes.push({ nodeId, success: true });
        local.succeeded(nodeId);
      },
    },
    commit() {
      for (const outcome of outcomes.splice(0)) {
        if (outcome.success) live.succeeded(outcome.nodeId);
        else live.failed(outcome.nodeId);
      }
    },
  };
}

// A longer cooldown needs another seller's accepted live quote for this request. Configured sellers
// that are ineligible, unavailable or cooling down cannot keep the only usable seller out longer.
export function backoffFor(
  backoff: SellerBackoff | undefined,
  config: { pinnedNodeId?: string },
  nodeId: string,
  alternativeNodeId?: string,
  signal?: AbortSignal,
) {
  if (
    !backoff ||
    signal?.aborted ||
    nodeId === config.pinnedNodeId ||
    !alternativeNodeId ||
    alternativeNodeId === nodeId
  )
    return undefined;
  return backoff;
}

// Snapshot failures arrive before other sellers have been verified or quoted. Record their ordinary
// cooldown first, then extend it only if the selection finds a usable alternative. Reports wait for
// that decision so retryAt agrees with the final cooldown.
export function selectionBackoff(
  backoff: SellerBackoff | undefined,
  config: { pinnedNodeId?: string },
  stats: Map<string, LocalSellerStats>,
  report: SellerFailureReporter | undefined,
  signal?: AbortSignal,
) {
  const outcomes: { nodeId: string; success: boolean }[] = [];
  const failures: SellerFailure[] = [];
  const pending: SellerBackoff | undefined = backoff
    ? {
        failed(nodeId) {
          outcomes.push({ nodeId, success: false });
          return BUYER_SELECTION.cooldownMs;
        },
        succeeded(nodeId) {
          outcomes.push({ nodeId, success: true });
        },
      }
    : undefined;
  return {
    backoff: pending,
    onSellerFailure: backoff
      ? (failure: SellerFailure) => failures.push(failure)
      : report,
    finish(alternativeNodeId?: string) {
      if (signal?.aborted) return;
      const cooldowns = new Map<string, number>();
      for (const outcome of outcomes) {
        if (outcome.success) {
          backoff?.succeeded(outcome.nodeId);
          cooldowns.delete(outcome.nodeId);
        } else {
          const active = backoffFor(
            backoff,
            config,
            outcome.nodeId,
            alternativeNodeId,
            signal,
          );
          cooldowns.set(
            outcome.nodeId,
            active?.failed(outcome.nodeId) ?? BUYER_SELECTION.cooldownMs,
          );
        }
      }
      for (const [nodeId, duration] of cooldowns) {
        const row = stats.get(nodeId);
        if (row?.cooldownUntil != null)
          stats.set(nodeId, {
            ...row,
            cooldownUntil:
              row.cooldownUntil - BUYER_SELECTION.cooldownMs + duration,
          });
      }
      for (const { retryAt, ...failure } of failures) {
        if (signal?.aborted) break;
        const until = stats.get(failure.nodeId)?.cooldownUntil;
        reportSellerFailure(report, {
          ...failure,
          ...(retryAt && until ? { retryAt: until } : {}),
        });
      }
    },
  };
}
