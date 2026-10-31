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
  // Claim attempts remembered per channel; the SDK re-awaits a pending one before sending again,
  // and a short list keeps each open channel's ledger growth small.
  maxClaimAttempts: 4,
  // Signature statuses that count as landed.
  landedStatuses: ['confirmed', 'finalized'],
} as const;
// Commitment for every chain read the seller makes.
export const UPTO_COMMITMENT = 'confirmed' as const;
// Commitment for reconciliation, which must never act on a transaction that could still roll back.
export const UPTO_FINAL_COMMITMENT = 'finalized' as const;
// Transactions read per channel address: an open, a claim and a close, with ample room.
export const UPTO_HISTORY_LIMIT = 32;
export type UptoCommitment =
  typeof UPTO_COMMITMENT | typeof UPTO_FINAL_COMMITMENT;
// CAIP-2 Solana networks: the namespace and the genesis-hash prefix length that names the chain.
export const UPTO_SOLANA_NAMESPACE = 'solana';
export const UPTO_SOLANA_REFERENCE_LENGTH = 32;
