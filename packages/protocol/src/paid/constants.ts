// Stable wire error codes used by priced inference over payment channels.
export const PAID_EXECUTION_CODES = {
  INVALID: 'INVALID_PAID_EXECUTION',
  VERSION: 'UNSUPPORTED_PAID_EXECUTION_VERSION',
  LIMIT: 'PAID_EXECUTION_LIMIT_EXCEEDED',
  BINDING: 'PAID_EXECUTION_BINDING_MISMATCH',
  SIGNATURE: 'INVALID_PAID_EXECUTION_SIGNATURE',
  EXPIRED: 'EXPIRED_PAID_EXECUTION_QUOTE',
  PEER: 'PAID_EXECUTION_PEER_MISMATCH',
  REPLAY: 'PAID_EXECUTION_REPLAY',
  NOT_PAID: 'PAID_EXECUTION_NOT_PAID',
  UNSUPPORTED: 'PAID_EXECUTION_UNSUPPORTED',
  BUSY: 'PAID_EXECUTION_BUSY',
  ENGINE: 'PAID_EXECUTION_ENGINE_UNAVAILABLE',
  TIMEOUT: 'PAID_EXECUTION_TIMEOUT',
  CANCELLED: 'PAID_EXECUTION_CANCELLED',
  INTERNAL: 'PAID_EXECUTION_INTERNAL_ERROR',
  // A started generation stopped on an engine failure; carries a stop reason.
  SELLER_CANNOT_CONTINUE: 'PAID_EXECUTION_SELLER_CANNOT_CONTINUE',
  // The authorization does not name the quote's request, ceiling or buyer.
  PAYMENT_MISMATCH: 'PAID_EXECUTION_PAYMENT_MISMATCH',
  // The payment server refused the authorization; nothing was deposited.
  PAYMENT_REJECTED: 'PAID_EXECUTION_PAYMENT_REJECTED',
  // The chain or facilitator could not be reached before any deposit.
  PAYMENT_UNAVAILABLE: 'PAID_EXECUTION_PAYMENT_UNAVAILABLE',
  // Generation stopped because the next tokens would exceed the deposited ceiling.
  BUDGET_EXHAUSTED: 'PAID_EXECUTION_BUDGET_EXHAUSTED',
} as const;
export type PaidExecutionCode =
  (typeof PAID_EXECUTION_CODES)[keyof typeof PAID_EXECUTION_CODES];
