// Owns the metrics collector's canonical values: wire error codes, statuses, routes, limits and binding
// names. Upload formats and signing domains belong to protocol; receipt policy belongs to core.
import { LOOPBACK_HOST_NAMES } from '@gyblos/config/hosts';

// Static `error` values on the wire. Request input is never echoed.
export const COLLECTOR_ERRORS = {
  INVALID_UPLOAD: 'INVALID_UPLOAD',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  // The uploader is not the seller (seller role) or buyer (buyer role) of a receipt, or an offer
  // does not cover the signed amount.
  UPLOAD_POLICY: 'UPLOAD_POLICY',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  // A buyer's disputed fields contradict its own observations.
  INCONSISTENT_DISPUTE: 'INCONSISTENT_DISPUTE',
  // `sentAt` is outside the clock window; the body carries the collector's time to correct and resend.
  STALE_UPLOAD: 'STALE_UPLOAD',
  // The same uploader already used this nonce.
  REPLAYED_UPLOAD: 'REPLAYED_UPLOAD',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  HTTPS_REQUIRED: 'HTTPS_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  UNAVAILABLE: 'COLLECTOR_UNAVAILABLE',
  // A stats query with a malformed day range or NodeId.
  INVALID_QUERY: 'INVALID_QUERY',
} as const;
export type CollectorErrorCode =
  (typeof COLLECTOR_ERRORS)[keyof typeof COLLECTOR_ERRORS];

export const COLLECTOR_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
export type CollectorStatus =
  (typeof COLLECTOR_STATUS)[keyof typeof COLLECTOR_STATUS];

export const COLLECTOR_ROUTES = {
  RECEIPTS: '/v1/receipts',
  HEALTH: '/v1/health',
  OBSERVATIONS: '/v1/observations',
  // Every public stats route starts with this; it selects the read limiter.
  STATS_PREFIX: '/v1/stats/',
  STATS_NETWORK: '/v1/stats/network',
  STATS_MODELS: '/v1/stats/models',
  STATS_SELLER: '/v1/stats/sellers/:nodeId',
  STATS_CHAIN: '/v1/stats/chain',
  STATS_CHAIN_TXS: '/v1/stats/chain/txs',
  // The operator's RPC probe (rpc-probe.ts): 404 unless its admin token is set and sent.
  RPC_PROBE: '/v1/admin/rpc-probe',
} as const;
// What an accepted envelope carried.
export const ENVELOPE_KINDS = {
  RECEIPTS: 'receipts',
  OBSERVATIONS: 'observations',
} as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[keyof typeof ENVELOPE_KINDS];
// Static code for unexpected failures; nothing else is reported.
export const COLLECTOR_INTERNAL_ERROR = 'COLLECTOR_INTERNAL_ERROR';
// Log code of a scheduled run whose days failed; followed by the UTC day names only.
export const COLLECTOR_AGGREGATION_FAILED = 'COLLECTOR_AGGREGATION_FAILED';

export const COLLECTOR_HEADERS = {
  CACHE_CONTROL: 'Cache-Control',
  CONTENT_TYPE: 'Content-Type',
  RETRY_AFTER: 'Retry-After',
  ROBOTS: 'X-Robots-Tag',
  CONTENT_TYPE_OPTIONS: 'X-Content-Type-Options',
  CLIENT_IP: 'CF-Connecting-IP',
  CONTENT_LENGTH: 'Content-Length',
} as const;
export const COLLECTOR_HEADER_VALUES = {
  NO_STORE: 'no-store',
  // Public aggregates: shared caches may keep them for the aggregation interval.
  PUBLIC_STATS: 'public, max-age=300',
  NOINDEX: 'noindex',
  NOSNIFF: 'nosniff',
  RETRY_AFTER_SECONDS: '60',
} as const;
export const COLLECTOR_PROTOCOLS = {
  SECURE: 'https:',
  LOOPBACK: 'http:',
} as const;
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(LOOPBACK_HOST_NAMES);

export const COLLECTOR_LIMITS = {
  // Above the envelope's structural maximum (about 170 KiB) plus JSON whitespace.
  maxBodyBytes: 393_216,
  maxJsonDepth: 32,
  // How far `sentAt` may differ from the collector's clock, either way.
  clockWindowMs: 600_000,
  // D1's limit of bound parameters per statement; multi-row writes are chunked under it.
  maxBoundParameters: 100,
  // Observations are buffered in memory on the node, so older events are not credible.
  maxObservationAgeMs: 2_592_000_000,
  // A receipt's signed receivedAt (the seller's clock) must fall within maxReceiptAgeMs before the
  // envelope's sentAt and at most receiptClockSkewMs after it: old days cannot be rewritten, and two
  // nodes' clocks may disagree. Keeps every aggregate day real and recent.
  maxReceiptAgeMs: 2_592_000_000,
  receiptClockSkewMs: 3_600_000,
  // Plausibility ceilings for one receipt, far above any real request, so aggregate sums stay exact.
  maxReceiptAtomic: 1_000_000_000_000,
  maxReceiptTokens: 100_000_000,
} as const;

// Cloudflare bindings (wrangler.jsonc); every one is required and missing ones fail closed.
export const COLLECTOR_DB_BINDING = 'COLLECTOR_DB';
export const COLLECTOR_LIMITERS = {
  // Per client address, before reading the body.
  IP: 'COLLECTOR_IP_LIMITER',
  // Per uploader NodeId, after its envelope signature verifies and before receipt verification, so
  // nobody can spend another node's allowance with unsigned junk.
  NODE: 'COLLECTOR_NODE_LIMITER',
  // One shared write budget for the whole collector, a ceiling on storage growth from free keys.
  GLOBAL: 'COLLECTOR_GLOBAL_LIMITER',
  // Per client address for the public stats reads, apart from uploads.
  READ: 'COLLECTOR_READ_LIMITER',
} as const;
export type CollectorLimiterName =
  (typeof COLLECTOR_LIMITERS)[keyof typeof COLLECTOR_LIMITERS];
// Hex radix for envelope ids derived from signatures; not a wire value.
export const HEX_RADIX = 16;

// Key of the shared write budget.
export const GLOBAL_LIMIT_KEY = 'global';

// Aggregates (#351). Changing a formula bumps formulaVersion; rows are then rebuilt from raw.
export const AGGREGATES = {
  // 2: origin and failure breakdowns (recomputes every day once).
  // 3: per-model observations (recomputes every day once).
  formulaVersion: 3,
  // Upper bounds of the latency histogram buckets, in ms; one more bucket holds everything above.
  // Fixed so histograms can be summed across hours, days, sellers and models.
  latencyBucketsMs: [
    100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000,
  ],
  // Upper bounds of the engine speed histogram buckets, in output tokens per second of generation;
  // one more bucket holds everything above.
  tokensPerSecondBuckets: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000],
  // Raw rows changed up to this long before the previous scan are scanned again, so an upload
  // committed while a scan ran is never missed. Recomputing a day twice is harmless.
  scanOverlapMs: 900_000,
  // Days recomputed per scheduled run; the rest stay dirty for the next run.
  maxDaysPerRun: 31,
  // Unique buyer counts (per seller and per network day) are public only at this count or more.
  minPublicBuyers: 5,
  // Public list caps: models per answer, and unserved-demand models per day.
  maxPublicModels: 100,
  maxPublicDemandPerDay: 20,
  // Public day ranges.
  maxRangeDays: 92,
  defaultRangeDays: 30,
  dayMs: 86_400_000,
  hourMs: 3_600_000,
  msPerSecond: 1_000,
} as const;
// Breakdown labels: a receipt no buyer upload carried, and unserved demand, which has no reason.
export const BREAKDOWNS = {
  unknownClient: 'unknown',
  noReason: 'none',
} as const;
export const FIRST_SEEN_KINDS = {
  SELLER: 'seller',
  // Free buyers are counted by NodeId, paid buyers by wallet; never merged.
  BUYER_FREE: 'buyer-free',
  BUYER_PAID: 'buyer-paid',
  MODEL: 'model',
} as const;
// The single row of collector_agg_state.
export const AGG_STATE_ID = 1;
export const CHAIN_CURSOR_ID = 1;

// Chain index (#349): the x402 payment-channels program (@x402/svm 2.28 Codama client). Discriminators
// are one u8 at data[0]; account positions are the program's instruction account order.
export const CHAIN_INSTRUCTIONS = {
  OPEN: 'open',
  SETTLE: 'settle',
  TOP_UP: 'top_up',
  SETTLE_AND_SEAL: 'settle_and_seal',
  REQUEST_CLOSE: 'request_close',
  SEAL: 'seal',
  DISTRIBUTE: 'distribute',
  RECLAIM: 'reclaim',
} as const;
export type ChainInstructionKind =
  (typeof CHAIN_INSTRUCTIONS)[keyof typeof CHAIN_INSTRUCTIONS];
// Scopes of the chain aggregates: the whole program, and channels that claim Gyblos traffic.
export const CHAIN_AGGREGATE_SCOPES = {
  PROGRAM: 'program',
  GYBLOS: 'gyblos',
} as const;
export type ChainAggregateScope =
  (typeof CHAIN_AGGREGATE_SCOPES)[keyof typeof CHAIN_AGGREGATE_SCOPES];
export const CHAIN_DISCRIMINATORS: ReadonlyMap<number, ChainInstructionKind> =
  new Map([
    [1, CHAIN_INSTRUCTIONS.OPEN],
    [2, CHAIN_INSTRUCTIONS.SETTLE],
    [3, CHAIN_INSTRUCTIONS.TOP_UP],
    [4, CHAIN_INSTRUCTIONS.SETTLE_AND_SEAL],
    [5, CHAIN_INSTRUCTIONS.REQUEST_CLOSE],
    [6, CHAIN_INSTRUCTIONS.SEAL],
    [7, CHAIN_INSTRUCTIONS.DISTRIBUTE],
    [9, CHAIN_INSTRUCTIONS.RECLAIM],
  ]);
// Positions in each instruction's account list.
export const CHAIN_ACCOUNTS = {
  open: {
    payer: 0,
    payee: 2,
    mint: 3,
    authorizedSigner: 4,
    channel: 5,
    count: 14,
  },
  settle: { channel: 0 },
  topUp: { payer: 0, channel: 1, mint: 4 },
  settleAndSeal: { payee: 0, channel: 1 },
  requestClose: { payer: 0, channel: 1 },
  seal: { channel: 0 },
  // Split recipients' token accounts follow the 11 fixed accounts.
  distribute: { channel: 0, payer: 1, mint: 7, fixed: 11 },
  reclaim: { channel: 0 },
} as const;
export const CHAIN_LAYOUT = {
  discriminatorBytes: 1,
  u16Bytes: 2,
  u32Bytes: 4,
  u64Bytes: 8,
  pubkeyBytes: 32,
  // A split recipient: 32-byte owner and u16 bps.
  recipientBytes: 34,
  // Ed25519 precompile: message offset (u16) at byte 10 of its 16-byte header, in its own data.
  ed25519MessageOffsetAt: 10,
  // Voucher message: 2 magic bytes, 32-byte channel id, u64 cumulative amount, i64 expiry.
  voucherMagic: [86, 1],
  voucherChannelAt: 2,
  voucherCumulativeAt: 34,
  voucherBytes: 50,
  // The channel account: 256 bytes; status at 3, deposit, settled and payout watermark u64 at 12, 20, 28.
  channelAccountBytes: 256,
  channelStatusAt: 3,
  channelDepositAt: 12,
  channelSettledAt: 20,
  channelPayoutAt: 28,
} as const;
// Channel account status byte, and the state after the account is reclaimed (gone).
export const CHAIN_CHANNEL_STATUSES = [
  'open',
  'sealed',
  'closing',
  'distributed',
] as const;
export const CHAIN_CHANNEL_CLOSED = 'closed';
export const CHAIN_TX_PAGE = {
  defaultLimit: 25,
  maxLimit: 50,
  params: { BEFORE: 'before', LIMIT: 'limit' },
} as const;
// The address holds no channel of this program (another owner, or another size).
export const CHAIN_CHANNEL_UNKNOWN = 'unknown';
export const CHAIN_PROGRAMS = {
  ED25519: 'Ed25519SigVerify111111111111111111111111111',
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
} as const;
// Open memos that mark a channel as Gyblos traffic (v1 upto terms, v2 payment sessions).
export const GYBLOS_OPEN_MEMOS = [
  'gyblos:',
  'gyblos/payment-session/v1:',
] as const;
export const CHAIN_INDEX = {
  // Signatures read per getSignaturesForAddress page (the RPC maximum).
  signaturesPerPage: 1000,
  // Program list pages read backwards per run while history is behind.
  maxListPagesPerRun: 5,
  // Followed Gyblos channels polled per run (least recently polled first), each at most this often.
  maxFollowedPerRun: 40,
  followIntervalMs: 1_800_000,
  // Transactions read per followed channel per poll; the rest wait for the next poll.
  maxReadsPerChannelPoll: 20,
  // How long a run holds the index; an overlapping run within it skips (the Cron wall limit is 15 min).
  leaseMs: 900_000,
  // History before this is never read (Gyblos devnet activity starts after it).
  historyFloorMs: Date.UTC(2026, 10, 1),
  // The free public devnet RPC: calls per run, and the pause between two calls (its limit is 40 calls
  // per 10 s per method and per address).
  publicCallsPerRun: 80,
  publicIntervalMs: 500,
  // The paid RPC, used only after the public one rate-limits a run: calls per run, at most.
  paidCallsPerRun: 20,
  paidIntervalMs: 0,
  // JSON-RPC error codes an endpoint uses for its own rate limit.
  rateLimitCodes: [429, -32429],
  // Channel accounts read per getMultipleAccounts request (the RPC maximum).
  accountsPerRequest: 100,
  requestTimeoutMs: 15_000,
  // Largest RPC answer read (a page of signatures or one jsonParsed transaction).
  maxResponseBytes: 8_388_608,
  // Highest Solana transaction version asked for: devnet already carries version 1 transactions.
  maxTransactionVersion: 1,
  msPerSecond: 1000,
} as const;
// Keyed providers whose key serves every Solana cluster under a per-cluster host: a configured
// mainnet host is read on its devnet host with the same key, since the index reads devnet. The
// genesis check (chain/rpc.ts) still refuses any endpoint that does not answer for devnet.
export const CHAIN_DEVNET_HOSTS: Readonly<Record<string, string>> = {
  'mainnet.helius-rpc.com': 'devnet.helius-rpc.com',
  'solana-mainnet.g.alchemy.com': 'solana-devnet.g.alchemy.com',
};
// Optional keyed Solana RPC URLs (secrets), tried in this order only when the public RPC (and then the
// previous one) fails the run: for example Helius, then Alchemy.
export const COLLECTOR_SOLANA_RPC_BINDINGS = [
  'COLLECTOR_SOLANA_RPC_URL',
  'COLLECTOR_SOLANA_RPC_FALLBACK_URL',
] as const;
// Operator token (secret) for the RPC probe; while unset the probe route does not exist.
export const COLLECTOR_ADMIN_TOKEN_BINDING = 'COLLECTOR_ADMIN_TOKEN';
// Log code of a scheduled run whose chain read failed; followed by a static reason only.
export const COLLECTOR_CHAIN_INDEX_FAILED = 'COLLECTOR_CHAIN_INDEX_FAILED';
// Log code of every scheduled chain read: calls per endpoint, rate limits, work done and backlog.
export const COLLECTOR_CHAIN_INDEX_RUN = 'COLLECTOR_CHAIN_INDEX_RUN';
