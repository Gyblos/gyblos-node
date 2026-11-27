export const D1_ANALYTICS = {
  databases: ['gyblos-discovery', 'gyblos-collector'],
  windowDays: 7,
  dayMs: 86_400_000,
  isoDayLength: 10,
  groupLimit: 10_000,
  graphqlUrl: 'https://api.cloudflare.com/client/v4/graphql',
  tokenEnv: 'CLOUDFLARE_API_TOKEN',
  accountEnv: 'CLOUDFLARE_ACCOUNT_ID',
  bytesPerMegabyte: 1_048_576,
  megabyteDigits: 2,
  latencyDigits: 2,
} as const;

export const D1_ANALYTICS_ERRORS = {
  WRANGLER_FAILED: 'd1_analytics_wrangler_failed',
  NO_TOKEN: 'd1_analytics_no_token',
  NO_ACCOUNT: 'd1_analytics_no_account',
  BAD_DATABASE_INFO: 'd1_analytics_bad_database_info',
  REQUEST_FAILED: 'd1_analytics_request_failed',
  BAD_RESPONSE: 'd1_analytics_bad_response',
  UNEXPECTED: 'd1_analytics_failed',
} as const;
export type D1AnalyticsError =
  (typeof D1_ANALYTICS_ERRORS)[keyof typeof D1_ANALYTICS_ERRORS];

export const D1_ANALYTICS_COLUMNS = [
  'database',
  'size MB',
  'read queries',
  'write queries',
  'rows read',
  'rows written',
  'p50 ms',
  'p95 ms',
] as const;

export const D1_BENCH_COLUMNS = [
  'operation',
  'statements',
  'round trips',
  'batches',
  'max params',
  'full scans',
] as const;
