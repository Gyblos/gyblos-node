// Owns the payment port catalogs and the payment binding wire strings: changing one breaks peers
// and on-chain memos. No SDK dependencies.
// Payment port failures (`payment.ts`); every adapter maps its own errors onto these.
export const PAYMENT_ERROR_CODES = {
  UNTRUSTED_TERMS: 'PAYMENT_UNTRUSTED_TERMS',
  ALREADY_AUTHORIZED: 'PAYMENT_ALREADY_AUTHORIZED',
  JOURNAL_UNAVAILABLE: 'PAYMENT_JOURNAL_UNAVAILABLE',
  AUTHORIZATION_MISMATCH: 'PAYMENT_AUTHORIZATION_MISMATCH',
  CHANNEL_REUSED: 'PAYMENT_CHANNEL_REUSED',
  INVALID_CHARGE: 'PAYMENT_INVALID_CHARGE',
  TERMS_EXPIRED: 'PAYMENT_TERMS_EXPIRED',
  ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  RECEIPT_MISMATCH: 'PAYMENT_RECEIPT_MISMATCH',
  UNAVAILABLE: 'PAYMENT_UNAVAILABLE',
  // The chain refused the claim for good (for example the payer's authorization expired): nothing
  // was or will be charged and the deposit returns to the payer. Unlike UNAVAILABLE, never retried.
  SETTLEMENT_LAPSED: 'PAYMENT_SETTLEMENT_LAPSED',
} as const;
export type PaymentErrorCode =
  (typeof PAYMENT_ERROR_CODES)[keyof typeof PAYMENT_ERROR_CODES];

// Buyer-journal state of one payment channel.
export const PAYMENT_CHANNEL_STATES = {
  OPEN: 'open',
  SETTLED: 'settled',
} as const;
export type PaymentChannelState =
  (typeof PAYMENT_CHANNEL_STATES)[keyof typeof PAYMENT_CHANNEL_STATES];

// Binds a deposit to every money field of its terms: the payer's wallet signs the memo of the
// channel open, whose text is memoPrefix + hex SHA-256 of termsDomain + canonical terms.
export const PAYMENT_BINDING = {
  termsDomain: 'gyblos/payment-terms/v1\n',
  memoPrefix: 'gyblos:',
  // The SVM upto open transaction carries at most one memo of this many bytes.
  memoBytes: 256,
  bpsDenominator: 10_000,
  // Upper bound on the protocol fee any terms may carry (10%), so a typo cannot drain sellers.
  maxFeeBps: 1_000,
  // Flooring two shares loses less than two units, so seller + fee falls at most one unit short.
  shareDustAtomic: 1,
} as const;
