// Owns the explorer's canonical values: units and display bounds. Public source URLs live in config.ts.

// Every read of a public source gives up after this long, so a slow source cannot hold a render.
export const FETCH = {
  timeoutMs: 8_000,
} as const;

// The discovery index is read in one place, by the Worker's scheduled run (scheduled.ts, every 2
// minutes), into a KV snapshot that every render reads (discovery.ts): the index's load does not grow
// with viewers. A run sends at most maxRequestsPerRun requests: under the Workers Free plan's 50
// subrequests per invocation and the index's 120 a minute per address.
export const DISCOVERY = {
  // Sellers per /sellers page: the index's largest page (DISCOVERY_INDEX_LIMITS.maxSellers).
  sellersPerPage: 200,
  // A model's list is read within one run, so a model with more than 43 pages of sellers (8 600) stays
  // unknown; a cursor that never ends costs one run's budget, not a loop.
  maxRequestsPerRun: 45,
  // Requests of a run kept for uptimes that are due, so seller lists never take the whole run.
  uptimeReservedPerRun: 15,
  // Uptime reads in flight at once: a Worker opens 6 connections at a time, and a queued read's
  // timeout would run while it waits.
  uptimeConcurrency: 6,
  // A seller's uptime is read again once its last read is this old (its windows span days).
  uptimeRefreshMs: 10 * 60 * 1000,
  // Older than this (two missed runs and a margin), the last read is shown as old, a network status is
  // no longer used, and without one, a seller list is no longer shown.
  staleAfterMs: 5 * 60 * 1000,
  // A render reuses the snapshot its Worker instance read this recently instead of reading KV again.
  reuseMs: 30 * 1000,
} as const;

export const UNITS = {
  usdcDecimals: 6,
  atomicPerUsdc: 1_000_000,
  msPerSecond: 1000,
  msPerDay: 24 * 60 * 60 * 1000,
  percent: 100,
  // Fixed-point scale for ratios of bigint amounts.
  ratioScale: 1_000_000,
} as const;

// Upper bounds of the collector's latency histogram buckets (AGGREGATES.latencyBucketsMs).
// The collector's first engine speed bucket bound (tokens per second).
export const FIRST_SPEED_BOUND = 1;
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
  // Uptime windows shown, in days.
  dayWindow: 1,
  weekWindow: 7,
  // Minimum width of wide tables, in px.
  wideTable: 860,
  dailyTable: 820,
  modelsTable: 1320,
  narrowTable: 420,
  defaultTable: 640,
  // Median latency.
  median: 0.5,
  // Decimal places of a percentage below 100%.
  percentDigits: 1,
  // Unique buyer counts below this are withheld by the collector.
  minPublicBuyers: 5,
} as const;

// The date range control: preset spans of UTC days ending today. The collector answers at most 92 days
// (AGGREGATES.maxRangeDays) and 30 by default.
export const RANGE = {
  param: 'range',
  presets: [7, 30, 90],
  defaultDays: 30,
  // "YYYY-MM-DD" from an ISO timestamp.
  dayPrecision: 10,
} as const;

// The open page refreshes its data in place: the discovery index changes within seconds, the
// collector's aggregates every 10 minutes (its cron), so once a minute is fresh enough. Only a visible
// tab refreshes; a tab coming back after longer than this refreshes at once.
export const LIVE = {
  refreshMs: 60 * 1000,
  // How often the "updated … ago" label is redrawn.
  labelMs: 5 * 1000,
} as const;
