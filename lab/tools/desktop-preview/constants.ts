// Visual-fixture settings only; never operator configuration, credentials or payment permission.
export const PREVIEW_DENSITY = {
  COMPACT: 'compact',
  COMFORTABLE: 'comfortable',
} as const;
export const PREVIEW_QUERY = {
  NETWORK: 'network',
  NETWORK_MAINNET: 'mainnet',
  TESTNET: 'testnet',
  TESTNET_HIDDEN: 'hidden',
} as const;

export const PREVIEW_FUNDING = {
  READY: 'ready',
  CHECKING: 'checking',
  READY_ATOMIC: 2_000_000,
  ATOMIC_PER_USDC: 1_000_000,
} as const;
export const CHAT_FILTER = {
  ALL: 'All chats',
  UNREAD: 'Unread',
  PINNED: 'Pinned',
} as const;
export const CHAT_STATE = { RUNNING: 'running', UNREAD: 'unread' } as const;
export const PREVIEW = {
  platform: 'darwin',
  nodeStartupMs: 3000,
  nextVersion: '0.2.0',
  apiOnlyEvery: 3,
  chatBaseTokens: 182,
  chatTokenStep: 11,
  apiBaseTokens: 368,
  apiTokenStep: 23,
  halfYearMonths: 6,
  weekDays: 7,
  percentScale: 100,
  dayMs: 86400000,
  minuteMs: 60000,
  halfHourMs: 1800000,
  replyDelayMs: 1400,
  balanceCheckDelayMs: 10000,
  priceScale: 1_000_000,
  medianMinOffers: 3,
  replyCents: 10,
  paymentIdCharacters: 64,
  recordedCents: 20,
  sessionLimitCents: 500,
  voidEvery: 4,
  capturedCents: 30,
  referenceOffset: 10,
  referenceRadix: 16,
  referencePadding: 7,
  title: 'Gyblos · Design preview · Example data',
  host: '127.0.0.1',
  port: 5196,
} as const;
