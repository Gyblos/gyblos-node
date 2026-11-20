// Desktop read-only announcement bounds and fixed IPC; not inference authorization.
export const CATALOG_STATE = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
  STALE: 'stale',
} as const;
export const NETWORK_CATALOG = {
  STATUS_CHANNEL: 'desktop:catalog-status',
  LOOKUP_CHANNEL: 'desktop:catalog-lookup',
  PARTITION: 'desktop-announcements',
  MAX_SUGGESTIONS: 6,
  OFFER_LABEL_DIGITS: 4,
  MAX_MODELS: 64,
  MAX_ANNOUNCEMENTS: 50,
  REQUEST_MS: 5000,
  REFRESH_MS: 30_000,
  PAGE_CONCURRENCY: 4,
  POLL_MS: 1000,
  MODEL_PATTERN:
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/,
} as const;
