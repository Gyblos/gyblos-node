// How long a seller stays cooled down after failing to connect or quote: 30 s the first time, twice as
// long after each further failure in a row, at most ten minutes, and back to normal on its first good
// quote. A seller that is gone is then asked less and less often, so it stops costing a request a wait
// every half minute. Counts live in memory for the buyer's lifetime (a restart starts over) and are not
// written to selection-stats.json, which older buyers read strictly.
import { BUYER_SELECTION } from './constants';

export interface SellerBackoff {
  // Records one more failure in a row and returns how long this cooldown lasts.
  failed(nodeId: string): number;
  succeeded(nodeId: string): void;
}

export function createSellerBackoff(): SellerBackoff {
  const streaks = new Map<string, number>();
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
