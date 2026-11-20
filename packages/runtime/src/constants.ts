// Runtime helper constants, diagnostic log states, error codes and degraded-logging warning.
// Rate-limit key used when no client address header is present.
export const LOCAL_CLIENT_KEY = 'local';

export const IPV6 = {
  groups: 8,
  prefixGroups: 4,
  hexRadix: 16,
} as const;

export const UNKNOWN_ERROR_NAME = 'UnknownError';

export const DIAGNOSTIC_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;
export type DiagnosticLevel =
  (typeof DIAGNOSTIC_LEVELS)[keyof typeof DIAGNOSTIC_LEVELS];
export const DIAGNOSTIC_OUTCOMES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  CLEANUP_FAILURE: 'cleanup_failure',
} as const;
export type DiagnosticOutcome =
  (typeof DIAGNOSTIC_OUTCOMES)[keyof typeof DIAGNOSTIC_OUTCOMES];
export const DIAGNOSTIC_CAUSES = {
  UNKNOWN: 'unknown',
  ASSERTION: 'assertion',
  ABORT: 'abort',
  TIMEOUT: 'timeout',
  SYNTAX: 'syntax',
} as const;
export type DiagnosticCause =
  (typeof DIAGNOSTIC_CAUSES)[keyof typeof DIAGNOSTIC_CAUSES];
export const DIAGNOSTIC_FORMAT = {
  schema: 1,
  sourceVersion: 'source',
  tokenCharacters: 80,
  followMs: 250,
  defaultRecords: 100,
  maxRecords: 1000,
  directoryEntryFactor: 4,
} as const;
export const DIAGNOSTIC_READ_ERROR = 'DIAGNOSTICS_UNAVAILABLE';

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
// A process lock file holds only its owner record; the guard beside it serializes takeovers.
export const PROCESS_LOCK = {
  maxBytes: 1024,
  guardSuffix: '.takeover',
} as const;
