// Owns the inactive collector backend's fixed safety bounds and static outcomes, not home paths.
export const RECEIPT_FILE_LIMITS = {
  entries: 256,
  bytes: 1048576,
  pending: 4,
  keyCharacters: 256,
} as const;
export const RECEIPT_FILE_FORMAT = {
  version: 1,
  lockSuffix: '.lock',
  stageSuffix: '.stage',
} as const;
export const RECEIPT_FILE_CODES = {
  INVALID_OPTIONS: 'RECEIPT_FILE_INVALID_OPTIONS',
  UNAVAILABLE: 'RECEIPT_FILE_UNAVAILABLE',
  CORRUPT: 'RECEIPT_FILE_CORRUPT',
  CLOSED: 'RECEIPT_FILE_CLOSED',
  BUSY: 'RECEIPT_FILE_BUSY',
  CANCELLED: 'RECEIPT_FILE_CANCELLED',
} as const;
export type ReceiptFileCode =
  (typeof RECEIPT_FILE_CODES)[keyof typeof RECEIPT_FILE_CODES];

export const RECEIPT_RETENTION = {
  version: 2,
  maximumMs: 604800000,
  keyFields: 3,
} as const;
