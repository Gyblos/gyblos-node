// Owns the Models table's rows: one per model as published (id, variant, quantization), joining what
// the discovery index offers now with what the collector saw served over the range. A model offered now
// keeps its row without receipts; a model no longer offered keeps its row while it has receipts. Free
// and paid stay apart. Pure functions, no I/O.
import type { ModelSide, ModelStat } from './collector-shape';
import { DISPLAY } from './constants';
import { mergedLatency, type LatencyBound } from './latency';
import { modelKey, type ModelOffers } from './offers';

export interface Served {
  completed: number;
  failed: number;
  cancelled: number;
  // Seller-measured time to the first token, median bucket bound.
  firstToken: LatencyBound;
}
export interface ModelRow {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  // Null when no seller offers it now.
  now: ModelOffers | null;
  // Null without receipts on that side in the range.
  free: Served | null;
  paid: Served | null;
}

function served(side: ModelSide | null): Served | null {
  if (!side) return null;
  const { completed, failed, cancelled } = side.outcomes;
  if (!completed && !failed && !cancelled) return null;
  return {
    completed,
    failed,
    cancelled,
    firstToken: mergedLatency([side.sellerLatency.firstToken], DISPLAY.median),
  };
}

// Completed out of the requests that ended in success or failure; cancellations are not failures.
export function completion(side: Served): {
  done: number;
  of: number;
  ratio: number | null;
} {
  const of = side.completed + side.failed;
  return { done: side.completed, of, ratio: of ? side.completed / of : null };
}

const finishedCount = (row: ModelRow) =>
  (row.free ? row.free.completed + row.free.failed + row.free.cancelled : 0) +
  (row.paid ? row.paid.completed + row.paid.failed + row.paid.cancelled : 0);

// Offered now first (most sellers first), then by requests served in the range, then by name.
export function modelRows(
  offered: Map<string, ModelOffers>,
  stats: ModelStat[],
): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const [key, offer] of offered)
    rows.set(key, {
      modelId: offer.modelId,
      variant: offer.variant,
      quantization: offer.quantization,
      now: offer,
      free: null,
      paid: null,
    });
  for (const stat of stats) {
    const key = modelKey(stat);
    const free = served(stat.free);
    const paid = served(stat.paid);
    const row = rows.get(key);
    if (row) {
      row.free = free;
      row.paid = paid;
    } else if (free || paid)
      rows.set(key, {
        modelId: stat.modelId,
        variant: stat.variant,
        quantization: stat.quantization,
        now: null,
        free,
        paid,
      });
  }
  return [...rows.values()].sort(
    (left, right) =>
      (right.now?.sellers ?? 0) - (left.now?.sellers ?? 0) ||
      finishedCount(right) - finishedCount(left) ||
      modelKey(left).localeCompare(modelKey(right)),
  );
}
