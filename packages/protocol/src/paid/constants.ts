// Owns the paid execution wire strings and bounds. These are wire strings: changing one breaks
// peers. Paid execution is stream-only; its codes mirror the free ones under their own names.
import { FREE_EXECUTION, FREE_STREAM } from '../constants';

export const PAID_EXECUTION = {
  alpn: 'gyblos/paid-stream/1',
  version: 1,
  requestDomain: 'gyblos/paid-execution-request/v1\n',
  // The free request bound plus room for the payment authorization.
  requestBytes: FREE_EXECUTION.requestBytes + 8192,
  // The scheme's signed channel open, base64; a Solana transaction is at most 1232 bytes.
  payloadBytes: 4096,
  // Channel ids, payer addresses and transaction signatures (base58, hex or similar).
  identifier: /^[A-Za-z0-9]{1,128}$/,
} as const;

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

// Free stream framing with room for the charge and payment in the terminal.
export const PAID_STREAM = {
  deltaBytes: FREE_STREAM.deltaBytes,
  eventBytes: FREE_STREAM.eventBytes + 2048,
  maxEvents: FREE_STREAM.maxEvents,
  totalBytes: FREE_STREAM.totalBytes + 2048,
  terminalReserveBytes: FREE_STREAM.terminalReserveBytes + 2048,
  events: FREE_STREAM.events,
} as const;
