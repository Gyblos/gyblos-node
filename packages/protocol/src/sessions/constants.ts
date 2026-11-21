// Catalogs for reusable payment sessions; existing execution and payment contracts stay independent.
export const SESSION_CODES = {
  OPENING_ABSENT: 'PAYMENT_SESSION_OPENING_ABSENT',
  OPENING_RETURNED: 'PAYMENT_SESSION_OPENING_RETURNED',
  OPENING_PENDING: 'PAYMENT_SESSION_OPENING_PENDING',
  INVALID: 'PAYMENT_SESSION_INVALID',
  BINDING: 'PAYMENT_SESSION_BINDING',
  BUSY: 'PAYMENT_SESSION_BUSY',
  CLOSED: 'PAYMENT_SESSION_CLOSED',
  LIMIT: 'PAYMENT_SESSION_LIMIT',
  UNVERIFIED: 'PAYMENT_SESSION_UNVERIFIED',
  UNAVAILABLE: 'PAYMENT_SESSION_UNAVAILABLE',
} as const;
export type SessionCode = (typeof SESSION_CODES)[keyof typeof SESSION_CODES];
export const OPENING_STATUS = {
  PRESENT: 'present',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
} as const;
export type OpeningStatus =
  (typeof OPENING_STATUS)[keyof typeof OPENING_STATUS];
export const SESSION_STATES = {
  OPENING: 'opening',
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
} as const;
export type SessionState = (typeof SESSION_STATES)[keyof typeof SESSION_STATES];
export const PAYMENT_SESSION = {
  version: 1,
  requestIdBytes: 16,
  digestBytes: 32,
  domain: 'gyblos/payment-session/v1\n',
  voucherExpiry: 0,
} as const;
