// Private diagnostic log states, error codes and the degraded-logging warning.
export const UNKNOWN_ERROR_NAME = 'UnknownError';

export const PRIVATE_LOG_STATES = {
  READY: 'ready',
  DEGRADED: 'degraded',
  CLOSED: 'closed',
} as const;

export const PRIVATE_LOG_CODES = {
  UNSAFE_PATH: 'UNSAFE_PATH',
  STORAGE_LIMIT: 'STORAGE_LIMIT',
  RECORD_LIMIT: 'RECORD_LIMIT',
  QUEUE_FULL: 'QUEUE_FULL',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  DRAIN_TIMEOUT: 'DRAIN_TIMEOUT',
  CLOSED: 'CLOSED',
} as const;

export const PRIVATE_LOG_WARNING =
  'Private diagnostic logging is degraded; inspect local diagnostic health.';

export type PrivateLogState =
  (typeof PRIVATE_LOG_STATES)[keyof typeof PRIVATE_LOG_STATES];
export type PrivateLogCode =
  (typeof PRIVATE_LOG_CODES)[keyof typeof PRIVATE_LOG_CODES];

// Private state files (private-file.ts): one static failure, so paths and OS text never leave.
export const PRIVATE_FILE_CODES = {
  UNAVAILABLE: 'PRIVATE_FILE_UNAVAILABLE',
} as const;
export type PrivateFileCode =
  (typeof PRIVATE_FILE_CODES)[keyof typeof PRIVATE_FILE_CODES];
// A process lock file holds only its owner record.
export const PROCESS_LOCK = { maxBytes: 1024 } as const;
