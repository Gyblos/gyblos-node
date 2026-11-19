// Owns the public shapes of summed totals: latency percentiles from fixed buckets, success rate, and the
// free/paid split. Free volume is labelled as not backed by payment; paid amounts are authorized usage
// signed by both sides, not revenue; unique buyer counts below AGGREGATES.minPublicBuyers are withheld.
import { AGGREGATES } from './constants';
import type { ReceiptTotals } from './schema-aggregates';

const BUCKETS = AGGREGATES.latencyBucketsMs;
const PERCENTILES = { p50: 0.5, p95: 0.95 } as const;

export interface Latency {
  samples: number;
  // Upper bound (ms) of the bucket holding the percentile; null when empty or above the last bound.
  p50Ms: number | null;
  p95Ms: number | null;
  // Upper bounds in ms; the last count is everything above the last bound.
  bucketsMs: readonly number[];
  counts: number[];
}

// A stored histogram over `edges`; anything malformed reads as empty rather than failing the response.
export function counts(
  text: string,
  edges: readonly number[] = BUCKETS,
): number[] {
  const empty = Array<number>(edges.length + 1).fill(0);
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
function percentile(
  values: readonly number[],
  share: number,
  edges: readonly number[] = BUCKETS,
): number | null {
  const samples = values.reduce((sum, value) => sum + value, 0);
  if (!samples) return null;
  let seen = 0;
  for (const [index, value] of values.entries()) {
    seen += value;
    if (seen >= samples * share) return edges[index] ?? null;
  }
  return null;
}
export function latency(text: string): Latency {
  const values = counts(text);
  return {
    samples: values.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(values, PERCENTILES.p50),
    p95Ms: percentile(values, PERCENTILES.p95),
    bucketsMs: BUCKETS,
    counts: values,
  };
}

const SPEED_BUCKETS = AGGREGATES.tokensPerSecondBuckets;
// The engine's output tokens per second of generation, from fixed buckets.
export interface Speed {
  samples: number;
  // Upper bound of the bucket holding the median; null when empty or above the last bound.
  p50TokensPerSecond: number | null;
  // Upper bounds in tokens per second; the last count is everything above the last bound.
  bucketsTokensPerSecond: readonly number[];
  counts: number[];
}
export function speed(text: string): Speed {
  const values = counts(text, SPEED_BUCKETS);
  return {
    samples: values.reduce((sum, value) => sum + value, 0),
    p50TokensPerSecond: percentile(values, PERCENTILES.p50, SPEED_BUCKETS),
    bucketsTokensPerSecond: SPEED_BUCKETS,
    counts: values,
  };
}

export interface TotalsSection {
  requests: {
    // Receipts confirmed by both sides plus seller-only ones.
    headline: number;
    bilateral: number;
    sellerOnly: number;
    disputed: number;
  };
  outcomes: { completed: number; failed: number; cancelled: number };
  successRate: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    // Receipts whose reasoning token count is unknown (not zero).
    reasoningUnknown: number;
  };
  sellerLatency: { firstToken: Latency; total: Latency };
}
export type FreeSection = TotalsSection & { backedByPayment: false };
export type PaidSection = TotalsSection & {
  // Usage both sides signed for, in USDC atomic units; settled USDC comes only from the chain.
  authorizedAtomic: string;
  feeAtomic: string;
};

function totalsSection(row: ReceiptTotals): TotalsSection {
  const finished = row.completed + row.failed + row.cancelled;
  return {
    requests: {
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
    successRate: finished ? row.completed / finished : null,
    tokens: {
      input: row.inputTokens,
      output: row.outputTokens,
      reasoning: row.reasoningTokens,
      reasoningUnknown: row.reasoningUnknown,
    },
    sellerLatency: {
      firstToken: latency(row.firstTokenHist),
      total: latency(row.totalHist),
    },
  };
}
export const freeSection = (row: ReceiptTotals): FreeSection => ({
  ...totalsSection(row),
  backedByPayment: false,
});
export const paidSection = (row: ReceiptTotals): PaidSection => ({
  ...totalsSection(row),
  authorizedAtomic: String(row.amountAtomic),
  feeAtomic: String(row.feeAtomic),
});

// Free and paid rows in their own sections, each extended by `extra`; a missing side is null.
export function bySide<T extends ReceiptTotals, E extends object>(
  rows: readonly T[],
  extra: (row: T) => E,
) {
  const free = rows.find((row) => !row.paid);
  const paid = rows.find((row) => row.paid);
  return {
    free: free ? { ...freeSection(free), ...extra(free) } : null,
    paid: paid ? { ...paidSection(paid), ...extra(paid) } : null,
  };
}

export interface PublicBuyers {
  // Distinct NodeIds (free) or wallets (paid); null when withheld.
  buyers: number | null;
  withheld: boolean;
}
// A unique buyer count, withheld below the public minimum (zero included).
export function publicBuyers(buyers: number | undefined): PublicBuyers {
  return buyers !== undefined && buyers >= AGGREGATES.minPublicBuyers
    ? { buyers, withheld: false }
    : { buyers: null, withheld: true };
}
// The model name as published: '' (none) reads as null.
export const nullable = (value: string) => (value === '' ? null : value);
