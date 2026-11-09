// Canonical labels and bounds for the buyer's local financial views.
export const HISTORY_METHOD = {
  ALL: 'All methods',
  USDC: 'USDC',
  PAYPAL: 'PayPal',
} as const;
export const HISTORY_PERIOD = {
  WEEK: 'Last 7 days',
  MONTH: 'Last 30 days',
  ALL: 'All time',
} as const;
export const HISTORY_SOURCE = {
  ALL: 'All usage',
  CHAT: 'Chat',
  AGENTS: 'Agents',
} as const;
export const HISTORY_KIND = {
  PAYMENT: 'Payment',
  USAGE: 'Usage',
  AUTHORIZATION: 'Authorization',
} as const;
export const FINANCIAL_TONE = {
  NEUTRAL: 'neutral',
  INCOMING: 'incoming',
  PENDING: 'pending',
  FAILED: 'failed',
} as const;
export const HISTORY_PAGE_SIZE = { SMALL: 10, MEDIUM: 25, LARGE: 50 } as const;
export const HISTORY = {
  DAY_MS: 86_400_000,
  WEEK_DAYS: 7,
  MONTH_DAYS: 30,
  PAGE_SIZES: [
    HISTORY_PAGE_SIZE.SMALL,
    HISTORY_PAGE_SIZE.MEDIUM,
    HISTORY_PAGE_SIZE.LARGE,
  ],
  PAGE_BUTTONS: 7,
  REFERENCE_PREFIX: 6,
  REFERENCE_SUFFIX: 4,
  REFERENCE_LENGTH: 14,
} as const;
export type HistoryMethod =
  (typeof HISTORY_METHOD)[keyof typeof HISTORY_METHOD];
export type HistoryPeriod =
  (typeof HISTORY_PERIOD)[keyof typeof HISTORY_PERIOD];
export type HistorySource =
  (typeof HISTORY_SOURCE)[keyof typeof HISTORY_SOURCE];
export type FinancialTone =
  (typeof FINANCIAL_TONE)[keyof typeof FINANCIAL_TONE];
