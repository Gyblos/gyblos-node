// Owns the public stats response shapes. Free and paid totals are always separate sections and never
// summed; free volume is labelled as not backed by payment; paid amounts are authorized usage, not
// revenue; per-seller buyer counts below AGGREGATES.minPublicBuyers are withheld.
import { AGGREGATES } from './constants';
import type { DayRange } from './stats-read';

// The additive columns every totals row shares (seller or network, one paid flag).
export interface TotalsFields {
  paid: number;
  bilateral: number;
  sellerOnly: number;
  disputed: number;
  completed: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningUnknown: number;
  amountAtomic: number;
  feeAtomic: number;
  firstTokenHist: string;
  totalHist: string;
}
const BUCKETS = AGGREGATES.latencyBucketsMs;
const PERCENTILES = { p50: 0.5, p95: 0.95 } as const;

// A stored histogram; anything malformed reads as empty rather than failing the response.
export function counts(text: string): number[] {
  const empty = Array<number>(BUCKETS.length + 1).fill(0);
  try {
    const value: unknown = JSON.parse(text);
    if (
      Array.isArray(value) &&
      value.length === empty.length &&
      value.every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
    )
      return value as number[];
  } catch {
    // Falls through to the empty histogram.
  }
  return empty;
}
// The upper bound (ms) of the bucket holding the percentile; null when empty or above the last bound.
function percentile(values: readonly number[], share: number): number | null {
  const samples = values.reduce((sum, value) => sum + value, 0);
  if (!samples) return null;
  let seen = 0;
  for (const [index, value] of values.entries()) {
    seen += value;
    if (seen >= samples * share) return BUCKETS[index] ?? null;
  }
  return null;
}
export function latency(text: string) {
  const values = counts(text);
  return {
    samples: values.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(values, PERCENTILES.p50),
    p95Ms: percentile(values, PERCENTILES.p95),
    // Upper bounds in ms; the last count is everything above the last bound.
    bucketsMs: BUCKETS,
    counts: values,
  };
}
const ratio = (part: number, whole: number) => (whole ? part / whole : null);

export function totalsSection(row: TotalsFields) {
  const settledOutcomes = row.completed + row.failed + row.cancelled;
  const common = {
    requests: {
      // Headline: receipts confirmed by both sides plus seller-only ones.
      headline: row.bilateral + row.sellerOnly,
      bilateral: row.bilateral,
      sellerOnly: row.sellerOnly,
      disputed: row.disputed,
    },
    outcomes: {
      completed: row.completed,
      failed: row.failed,
      cancelled: row.cancelled,
    },
    successRate: ratio(row.completed, settledOutcomes),
    tokens: {
      input: row.inputTokens,
      output: row.outputTokens,
      reasoning: row.reasoningTokens,
      // Receipts whose reasoning token count is unknown (not zero).
      reasoningUnknown: row.reasoningUnknown,
    },
    sellerLatency: {
      firstToken: latency(row.firstTokenHist),
      total: latency(row.totalHist),
    },
  };
  return row.paid
    ? {
        ...common,
        // Signed authorized usage; settled USDC comes only from the chain.
        authorizedAtomic: String(row.amountAtomic),
        feeAtomic: String(row.feeAtomic),
      }
    : { ...common, backedByPayment: false as const };
}

// Splits free and paid rows into their own sections; a missing side is null.
export function bySide<T extends { paid: number }, S>(
  rows: readonly T[],
  shape: (row: T) => S,
) {
  const free = rows.find((row) => !row.paid);
  const paid = rows.find((row) => row.paid);
  return {
    free: free ? shape(free) : null,
    paid: paid ? shape(paid) : null,
  };
}
// Every UTC day of the range, oldest first.
export function daysOf(range: DayRange): string[] {
  const days: string[] = [];
  for (
    let at = Date.parse(`${range.from}T00:00:00.000Z`);
    at <= Date.parse(`${range.to}T00:00:00.000Z`);
    at += AGGREGATES.dayMs
  )
    days.push(new Date(at).toISOString().split('T')[0]!);
  return days;
}
// A per-seller buyer count, withheld below the public minimum.
export function publicBuyers(buyers: number | undefined) {
  if (buyers === undefined) return { buyers: 0, withheld: false };
  return buyers >= AGGREGATES.minPublicBuyers
    ? { buyers, withheld: false }
    : { buyers: null, withheld: true };
}
// The model name as published: '' (none) reads as null.
export const nullable = (value: string) => (value === '' ? null : value);
