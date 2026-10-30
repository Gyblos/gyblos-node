// Owns the package's stable failure codes; callers branch on these, never on message text.
export const UPTO_ERROR_CODES = {
  INVALID_TERMS: 'UPTO_INVALID_TERMS',
  AUTHORIZATION_MISMATCH: 'UPTO_AUTHORIZATION_MISMATCH',
  CHANNEL_REUSED: 'UPTO_CHANNEL_REUSED',
  CHARGE_EXCEEDS_CEILING: 'UPTO_CHARGE_EXCEEDS_CEILING',
  ALREADY_SETTLED: 'UPTO_ALREADY_SETTLED',
  JOURNAL_UNAVAILABLE: 'UPTO_JOURNAL_UNAVAILABLE',
  FACILITATOR_REJECTED: 'UPTO_FACILITATOR_REJECTED',
  TERMS_EXPIRED: 'UPTO_TERMS_EXPIRED',
  UNAVAILABLE: 'UPTO_UNAVAILABLE',
  INTERNAL: 'UPTO_INTERNAL',
} as const;

export type UptoErrorCode =
  (typeof UPTO_ERROR_CODES)[keyof typeof UPTO_ERROR_CODES];

export const UPTO = {
  scheme: 'upto',
  x402Version: 2,
} as const;

// A channel's write-ahead state on the seller: each is recorded before the step it names.
export const UPTO_CHANNEL_STATES = {
  DEPOSITING: 'depositing',
  ADMITTED: 'admitted',
  SETTLING: 'settling',
  SETTLED: 'settled',
} as const;
export type UptoChannelState =
  (typeof UPTO_CHANNEL_STATES)[keyof typeof UPTO_CHANNEL_STATES];
