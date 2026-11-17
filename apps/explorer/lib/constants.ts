// Owns the explorer's canonical values: cache lives per source, Solana RPC pacing and paging, units
// and display bounds. Public source URLs live in config.ts.

// How long each source's answer is served from the Next.js cache, in seconds.
export const CACHE_LIFE = {
  // The discovery index changes with every presence (about every minute).
  discovery: { stale: 30, revalidate: 60, expire: 3600 },
  // The collector recomputes aggregates every 10 minutes.
  collector: { stale: 60, revalidate: 300, expire: 3600 },
  // The treasury's signature list; finalized transactions are stored on disk instead.
  signatures: { stale: 60, revalidate: 120, expire: 86_400 },
} as const;

export const DISCOVERY = {
  // Pages of sellers read per model.
  maxSellerPages: 10,
} as const;

export const SOLANA_RPC = {
  jsonRpc: '2.0',
  // The public devnet RPC rate-limits bursts: calls are spaced unless SOLANA_RPC_URL is set.
  publicSpacingMs: 700,
  maxAttempts: 7,
  tooManyRequests: 429,
  // Backoff after 429: baseMs × 2^min(attempt, maxBackoffExponent).
  backoffBaseMs: 1000,
  maxBackoffExponent: 3,
  // getSignaturesForAddress page size and pages per treasury token account.
  signaturesPerPage: 1000,
  maxSignaturePages: 5,
  // A channel instruction carries more accounts than this; [channel, payer, payee signer, ...].
  minChannelAccounts: 3,
  payerAccountIndex: 1,
  // Pause between getTransaction calls while filling the local store.
  fillSpacingMs: 1500,
  // How long a request waits for missing transactions before answering with what it has.
  fillWaitMs: 8000,
} as const;

// How a settlement transaction is read: a Gyblos fee was paid, or the channel only refunded.
export const SETTLEMENT_KINDS = {
  SETTLEMENT: 'settlement',
  REFUND: 'refund',
} as const;
export type SettlementKind =
  (typeof SETTLEMENT_KINDS)[keyof typeof SETTLEMENT_KINDS];

export const UNITS = {
  usdcDecimals: 6,
  msPerSecond: 1000,
  percent: 100,
  // Fixed-point scale for ratios of bigint amounts.
  ratioScale: 1_000_000,
} as const;

// Upper bounds of the collector's latency histogram buckets (AGGREGATES.latencyBucketsMs).
export const LATENCY_BUCKETS_MS = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000,
] as const;

export const DISPLAY = {
  // Digits of a short address on each side of the ellipsis.
  addressHead: 4,
  addressTail: 4,
  // Digits of a short transaction signature on each side of the ellipsis.
  signatureEdge: 6,
  // "YYYY-MM-DD HH:MM" from an ISO timestamp.
  minutePrecision: 16,
  // Most recent settlements listed, and the most recent days in the volume chart.
  recentSettlements: 25,
  chartDays: 10,
  // Uptime windows shown, in days.
  dayWindow: 1,
  weekWindow: 7,
  // Minimum width of wide tables, in px.
  wideTable: 760,
  dailyTable: 820,
  narrowTable: 420,
  defaultTable: 640,
  // Median latency.
  median: 0.5,
  // Decimal places of a percentage below 100%.
  percentDigits: 1,
  // Unique buyer counts below this are withheld by the collector.
  minPublicBuyers: 5,
  // Volume chart: bar heights in tenths of a percent, never below barMinPercent so a bar shows.
  barScale: 1000n,
  barScaleToPercent: 10,
  barMinPercent: 2,
  // "MM-DD" from "YYYY-MM-DD".
  monthDayStart: 5,
} as const;
