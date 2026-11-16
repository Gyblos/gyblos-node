// Owns the paid execution wire strings and bounds. These are wire strings: changing one breaks
// peers. Paid execution is stream-only; its codes mirror the free ones under their own names.
// Not re-exported by ../constants: this module reads FREE_* from there, so a re-export would
// create an import cycle.
import { CONTROL_LIMITS, FREE_EXECUTION, FREE_STREAM } from '../constants';

// Room the payment authorization adds to a request, and the charge and payment to a terminal.
const AUTHORIZATION_BYTES = 8192;
const PAYMENT_TERMINAL_BYTES = 2048;

// The request bound stays at 128 KiB before authorization. The coordinated beta profile permits
// 32768 one-token deltas plus a terminal; it does not negotiate an older reader's smaller bounds.
const PAID_V1_REQUEST_BYTES = 131072;
const PAID_DELTA_EVENTS = FREE_STREAM.maxEvents;
// Maximum canonical delta envelope including its four-byte prefix: fixed keys/version/type,
// 32 request-id hex characters, 64 digest hex characters and a five-digit sequence. Tested on wire.
const PAID_DELTA_HEADER_BYTES = 189;
// A control byte may become six ASCII bytes (\\u0000) in canonical JSON.
const JSON_ESCAPE_BYTES = 6;
const PAID_EVENT_BYTES = FREE_STREAM.eventBytes + PAYMENT_TERMINAL_BYTES;
const PAID_TERMINAL_FRAME_BYTES = PAID_EVENT_BYTES + CONTROL_LIMITS.prefixBytes;

export const PAID_EXECUTION = {
  version: 2,
  requestDomain: 'gyblos/paid-execution-request/v2\n',
  unsignedRequestBytes: PAID_V1_REQUEST_BYTES,
  requestBytes: PAID_V1_REQUEST_BYTES + AUTHORIZATION_BYTES,
  responseBytes: FREE_EXECUTION.responseBytes + PAYMENT_TERMINAL_BYTES,
  // The scheme's signed channel open, base64; a Solana transaction is at most 1232 bytes.
  payloadBytes: 4096,
  // Channel ids, payer addresses and transaction signatures (base58, hex or similar).
  identifier: /^[A-Za-z0-9]{1,128}$/,
} as const;

// Budget escaped output and every envelope separately, then reserve a whole terminal frame,
// which repeats the completed text. Per-frame, output, token, deposit and deadline bounds still apply.
export const PAID_STREAM = {
  alpn: 'gyblos/paid-stream/2',
  deltaBytes: FREE_STREAM.deltaBytes,
  eventBytes: PAID_EVENT_BYTES,
  maxEvents: PAID_DELTA_EVENTS + 1,
  totalBytes:
    PAID_DELTA_EVENTS * PAID_DELTA_HEADER_BYTES +
    FREE_EXECUTION.outputBytes * JSON_ESCAPE_BYTES +
    PAID_TERMINAL_FRAME_BYTES,
  terminalReserveBytes: PAID_TERMINAL_FRAME_BYTES,
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
