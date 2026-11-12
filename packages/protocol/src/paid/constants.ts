// Owns the paid execution wire strings and bounds. These are wire strings: changing one breaks
// peers. Paid execution is stream-only; its codes mirror the free ones under their own names.
// Not re-exported by ../constants: this module reads FREE_* from there, so a re-export would
// create an import cycle.
import { FREE_EXECUTION, FREE_STREAM } from '../constants';

// Room the payment authorization adds to a request, and the charge and payment to a terminal.
const AUTHORIZATION_BYTES = 8192;
const PAYMENT_TERMINAL_BYTES = 2048;

// Paid v1 keeps the bounds it shipped with when free execution moved to v4 (128 KiB requests, 4096
// events); changing them is a paid version change.
const PAID_V1_REQUEST_BYTES = 131072;
const PAID_V1_MAX_EVENTS = 4096;

export const PAID_EXECUTION = {
  version: 2,
  requestDomain: 'gyblos/paid-execution-request/v2\n',
  requestBytes: PAID_V1_REQUEST_BYTES + AUTHORIZATION_BYTES,
  responseBytes: FREE_EXECUTION.responseBytes + PAYMENT_TERMINAL_BYTES,
  // The scheme's signed channel open, base64; a Solana transaction is at most 1232 bytes.
  payloadBytes: 4096,
  // Channel ids, payer addresses and transaction signatures (base58, hex or similar).
  identifier: /^[A-Za-z0-9]{1,128}$/,
} as const;

// Free stream framing with room for the charge and payment in the terminal.
export const PAID_STREAM = {
  alpn: 'gyblos/paid-stream/2',
  deltaBytes: FREE_STREAM.deltaBytes,
  eventBytes: FREE_STREAM.eventBytes + PAYMENT_TERMINAL_BYTES,
  maxEvents: PAID_V1_MAX_EVENTS,
  totalBytes: FREE_STREAM.totalBytes + PAYMENT_TERMINAL_BYTES,
  terminalReserveBytes:
    FREE_STREAM.terminalReserveBytes + PAYMENT_TERMINAL_BYTES,
  events: FREE_STREAM.events,
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

// Refusals before any deposit: their terminals never carry a charge or payment.
export const PAID_REFUSAL_CODES: readonly PaidExecutionCode[] = [
  PAID_EXECUTION_CODES.INVALID,
  PAID_EXECUTION_CODES.VERSION,
  PAID_EXECUTION_CODES.LIMIT,
  PAID_EXECUTION_CODES.BINDING,
  PAID_EXECUTION_CODES.SIGNATURE,
  PAID_EXECUTION_CODES.EXPIRED,
  PAID_EXECUTION_CODES.PEER,
  PAID_EXECUTION_CODES.REPLAY,
  PAID_EXECUTION_CODES.NOT_PAID,
  PAID_EXECUTION_CODES.UNSUPPORTED,
  PAID_EXECUTION_CODES.BUSY,
  PAID_EXECUTION_CODES.PAYMENT_MISMATCH,
  PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE,
];
// Stops that only happen after a deposit, so their terminals always carry a charge and payment.
export const PAID_DEPOSITED_CODES: readonly PaidExecutionCode[] = [
  PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  PAID_EXECUTION_CODES.BUDGET_EXHAUSTED,
];
// Stops of a started generation that may report delivered output and charge for it.
export const PAID_DELIVERED_CODES: readonly PaidExecutionCode[] = [
  PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  PAID_EXECUTION_CODES.BUDGET_EXHAUSTED,
  PAID_EXECUTION_CODES.TIMEOUT,
  PAID_EXECUTION_CODES.CANCELLED,
];
