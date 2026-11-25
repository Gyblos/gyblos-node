// Owns the explorer's canonical values: source read bounds, the discovery schedule's budgets, units and
// display bounds. Public source URLs live in config.ts.

// Every read of a public source gives up after this long, so a slow source cannot hold a render.
export const FETCH = {
  timeoutMs: 8_000,
} as const;

// The discovery index is read in one place, by the Worker's scheduled run (scheduled.ts, on the cron
// in wrangler.jsonc), into KV that every render reads (discovery-snapshot.ts): the index's load does
// not grow with viewers. A run sends at most maxRequestsPerRun requests: under the Workers Free plan's
// 50 subrequests per invocation (its KV read and write count too) and the index's 120 a minute per
// address. A whole read of a large index spans several runs. On the Free plan a run also has 10 ms of
// CPU, which parsing a few hundred sellers can exceed: an index that large needs the Workers Paid plan.
export const DISCOVERY = {
  // Bump the version whenever StoredDiscovery changes: renders show nothing until the next whole read.
  storedKey: 'discovery/v1',
  // Sellers per /sellers page: the index's largest page (DISCOVERY_INDEX_LIMITS.maxSellers).
  sellersPerPage: 200,
  maxRequestsPerRun: 45,
  // No request of a run begins after this long, so a run with requests at the fetch timeout still ends
  // well before the next run (2 minutes later) and never overlaps it.
  runDeadlineMs: 20 * 1000,
  // Due uptimes a run tries before its catalog reading, none begun after reservedUptimesMs, so neither a
  // slow catalog read nor a slow /uptime takes every run's requests and time.
  reservedUptimes: 15,
  reservedUptimesMs: 6 * 1000,
  // Uptime reads in flight at once: a Worker opens 6 connections at a time, and a queued read's
  // timeout would run while it waits.
  uptimeConcurrency: 6,
  // A seller's uptime is tried again this long after its last try (its windows span days).
  uptimeRefreshMs: 10 * 60 * 1000,
  // An uptime whose tries have failed for this long is no longer shown.
  uptimeMaxAgeMs: 24 * 60 * 60 * 1000,
  // A catalog read under way this long (a model that keeps failing or never fits in a run) begins again,
  // and a shown catalog whose read began this long ago is dated on the page. A catalog needing more runs
  // than fit in this time (about 800 seller pages) never completes, and the last one stays shown, dated.
  restartAfterMs: 60 * 60 * 1000,
  // When the catalog has not been read further for this long (two runs and a margin), the page says when
  // the catalog it shows was read.
  staleAfterMs: 5 * 60 * 1000,
  // A render reuses the stored read its Worker instance read this recently instead of reading KV again;
  // under `next dev`, how often a render runs the read itself.
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
  statCards: 4,
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
  txTable: 1180,
  dailyTable: 1100,
  modelsTable: 1800,
  narrowTable: 420,
  defaultTable: 640,
  // Median latency.
  median: 0.5,
  // Decimal places of a displayed percentage.
  percentDigits: 1,
  // Unique buyer counts below this are withheld by the collector.
  minPublicBuyers: 5,
  maxPublicModels: 100,
} as const;

export const CHAIN_TXS = {
  param: 'before',
  limitParam: 'limit',
  recipientParam: 'recipient',
  pageRows: 5,
} as const;

export const PAGING = {
  rowsPerPage: 5,
  maxPageDigits: 6,
  params: {
    sellers: 'sellersPage',
    offline: 'offlinePage',
    models: 'modelsPage',
    daily: 'dailyPage',
    demand: 'demandPage',
    chainDaily: 'chainDailyPage',
    transactions: 'txPage',
  },
  anchors: {
    sellers: 'sellers',
    offline: 'not-online',
    models: 'models',
    daily: 'daily',
    demand: 'unserved-demand',
    chainDaily: 'daily-on-chain',
    transactions: 'channel-transactions',
  },
  cursorTable: 'transactions',
  sortParams: {
    sellers: 'sellersSort',
    offline: 'offlineSort',
    models: 'modelsSort',
    daily: 'dailySort',
    demand: 'demandSort',
    chainDaily: 'chainDailySort',
  },
  sortKeys: {
    sellers: ['context', 'input', 'output', 'uptimeDay', 'uptimeWeek', 'since'],
    offline: ['lastSeen', 'firstSeen'],
    models: ['input', 'output', 'context'],
    daily: ['day'],
    demand: ['requests'],
    chainDaily: ['day', 'settled', 'paidOut'],
  },
  descendingPrefix: '-',
} as const;

export const PAGES = {
  network: '/',
  sellers: '/sellers',
  models: '/models',
  transactions: '/transactions',
  stats: '/stats',
} as const;

export const HELP_TRIGGER = {
  delay: 150,
  shouldCloseOnPress: false,
} as const;

export const PAGE_LINKS = [
  { label: 'Network', href: PAGES.network },
  { label: 'Sellers', href: PAGES.sellers },
  { label: 'Models', href: PAGES.models },
  { label: 'Transactions', href: PAGES.transactions },
  { label: 'Stats', href: PAGES.stats },
] as const;

export const HASH_SCROLL = {
  maxWaitMs: 15 * 1000,
} as const;

export const TX_TEXT = {
  batched: 'part of a payout of several channels; see the transaction',
  batchTotal: 'batch total',
} as const;

export const NODE_STATE = {
  online: 'online',
  offline: 'offline',
  unpublished: 'unpublished',
} as const;

export const SELLER_STATUS = {
  unknown: 'unknown',
} as const;

// The date range control: preset spans of UTC days ending today. The collector answers at most 92 days
// (AGGREGATES.maxRangeDays) and 30 by default.
export const RANGE = {
  param: 'range',
  sections: {
    overview: { param: 'overviewRange', tables: [] },
    models: { param: 'modelsRange', tables: ['models'] },
    usage: { param: 'usageRange', tables: ['daily', 'demand'] },
    payments: { param: 'paymentsRange', tables: ['chainDaily'] },
    activity: { param: 'activityRange', tables: ['models', 'daily'] },
  },
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

export const IDENTITY = {
  verifiedParam: 'verified',
  verifiedValue: '1',
  bandsPerUnit: 100,
  gridSize: 5,
  cellPx: 4,
  hashOffset: 2_166_136_261,
  hashPrime: 16_777_619,
} as const;

export const SELLER_NAME = {
  hint: 'self-chosen name, not verified',
  unsafe: /[@✓✔✅☑\p{Cc}\p{Cf}]/u,
} as const;

export const COVERAGE_STATES = {
  FINAL: 'final',
  PARTIAL: 'partial',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
} as const;
export type CoverageState =
  (typeof COVERAGE_STATES)[keyof typeof COVERAGE_STATES];
export const COVERAGE_NOTES: Partial<Record<CoverageState, string>> = {
  [COVERAGE_STATES.PARTIAL]: 'so far',
  [COVERAGE_STATES.PENDING]: 'pending',
  [COVERAGE_STATES.UNKNOWN]: 'not captured',
};
