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
  // Base64 characters of an authorization payload; a Solana transaction is at most 1232 bytes.
  payloadBytes: 4096,
} as const;

// A channel's write-ahead state on the seller: each is recorded before the step it names.
export const UPTO_CHANNEL_STATES = {
  DEPOSITING: 'depositing',
  ADMITTED: 'admitted',
  SETTLING: 'settling',
  SETTLED: 'settled',
  // The deposit was refused or can no longer land; terminal, kept so the channel is never admitted
  // again.
  FAILED: 'failed',
  // The chain refused the claim for good (for example the payer's authorization expired); the
  // deposit returns to the payer and nothing is charged. Terminal.
  LAPSED: 'lapsed',
} as const;
export type UptoChannelState =
  (typeof UPTO_CHANNEL_STATES)[keyof typeof UPTO_CHANNEL_STATES];

// What the chain shows for a deposit whose outcome the seller did not observe.
export const UPTO_DEPOSIT_STATES = {
  LANDED: 'landed',
  // The open can no longer land (for example its blockhash expired) and did not.
  NEVER: 'never',
  // Not landed yet but still able to.
  PENDING: 'pending',
} as const;
export type UptoDepositState =
  (typeof UPTO_DEPOSIT_STATES)[keyof typeof UPTO_DEPOSIT_STATES];

// The payment-channels program's channel account, as the SDK decodes it.
export const UPTO_CHANNEL_ACCOUNT = {
  statuses: { OPEN: 0, SEALED: 1, CLOSING: 2, DISTRIBUTED: 3 },
  // Signatures read to find the sealing transaction; a channel lives through a handful.
  signatureLimit: 50,
} as const;
