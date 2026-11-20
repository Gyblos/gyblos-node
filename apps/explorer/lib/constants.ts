// Owns the explorer's canonical values: units and display bounds. Public source URLs live in config.ts.

// Every read of a public source gives up after this long, so a slow source cannot hold a render.
export const FETCH = {
  timeoutMs: 8_000,
} as const;

const MAX_SELLER_PAGES = 10;
// Bounds on one read of the discovery index (the index itself answers no-store): past them the page
// shows what was read. One read costs at most 22 requests (1 /models, 10 /sellers, 1 /network,
// 10 /uptime) and is shared by the renders of a data center (shared-read.ts): reads follow one another,
// each fresh for at least 15 s, so a data center reads at most 4 times (88 requests) a minute, under
// the index's 120 a minute per address that all explorer requests share; renders that look in the same
// instant as the entry goes stale are the exception.
export const DISCOVERY = {
  // Pages of /sellers read in all, across every model.
  maxSellerPages: MAX_SELLER_PAGES,
  // Sellers whose uptime is read; the rest show none.
  maxUptimeReads: 10,
  // How long one complete read serves every render (the live refresh runs once a minute).
  freshSeconds: 30,
  // How long a read with a secondary answer missing (/network or an uptime) serves every render.
  partialFreshSeconds: 15,
  // How long the last read stays servable while another render reads, or after a failed read.
  keepSeconds: 600,
  // Longer than the slowest read: /models, every /sellers page one after another, then /network and
  // the uptimes together, each at the fetch timeout, plus a margin.
  readingLeaseSeconds: ((MAX_SELLER_PAGES + 2) * FETCH.timeoutMs) / 1000 + 8,
  // No render reads again this long after a failed read.
  failedBackoffSeconds: 15,
  // How long a render without any read to serve waits for another render's read.
  waitSeconds: 10,
  waitPollMs: 250,
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
