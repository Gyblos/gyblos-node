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
  MAX_MODELS: 64,
  MAX_ANNOUNCEMENTS: 50,
  REQUEST_MS: 5000,
  POLL_MS: 1000,
  MODEL_PATTERN:
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/,
} as const;
