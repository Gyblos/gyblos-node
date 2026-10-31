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
  // A transaction the payer itself sent landed with an error, or its preflight refused it.
  CHAIN_REJECTED: 'UPTO_CHAIN_REJECTED',
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
// Pages read before the history counts as incomplete: past that, a channel is left open.
export const UPTO_HISTORY_PAGES = 10;
export type UptoCommitment =
  typeof UPTO_COMMITMENT | typeof UPTO_FINAL_COMMITMENT;
// CAIP-2 Solana networks: the namespace and the genesis-hash prefix length that names the chain.
export const UPTO_SOLANA_NAMESPACE = 'solana';
export const UPTO_SOLANA_REFERENCE_LENGTH = 32;
// The payment-channels program, for the payer's withdrawal: its instructions as the SDK encodes them.
export const UPTO_PROGRAM = {
  id: 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX',
  associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  systemProgram: '11111111111111111111111111111111',
  // The associated token program's CreateIdempotent: a no-op when the account already exists.
  createTokenAccountIdempotent: 1,
  eventAuthoritySeed: 'event_authority',
  discriminators: { REQUEST_CLOSE: 5, SEAL: 6, DISTRIBUTE: 7 },
  // Where each network's program binary sends the payouts it redirects.
  treasuryOwners: {
    devnet: '4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap',
    mainnet: 'Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP',
  },
} as const;
// The payer's withdrawal, one step per run: what it did to each channel.
export const UPTO_WITHDRAW_STEPS = {
  // request_close was sent; the grace period runs from when it lands.
  CLOSE_REQUESTED: 'close-requested',
  // Closing, but the grace period has not elapsed on chain yet.
  WAITING: 'waiting',
  // seal and distribute (or distribute alone) were sent: the escrow pays out and refunds the payer.
  DISTRIBUTED: 'distributed',
  // Already distributed, or no channel account at the address: nothing to send.
  NOTHING: 'nothing',
  // The account is not this payer's channel with these terms; nothing was signed.
  REFUSED: 'refused',
} as const;
export type UptoWithdrawStep =
  (typeof UPTO_WITHDRAW_STEPS)[keyof typeof UPTO_WITHDRAW_STEPS];
export const UPTO_WITHDRAW = {
  // Waiting for a sent transaction to confirm, and how often its status is read.
  confirmMs: 60_000,
  pollMs: 2_000,
  // Each RPC call's own deadline, so a hung endpoint never holds the caller's lock.
  rpcMs: 20_000,
  // Added to the grace period before sealing, so clock drift never makes a seal fail.
  graceMarginSeconds: 5,
  // When to look again at an unconfirmed transaction, or a block whose time is not known yet.
  recheckSeconds: 30,
} as const;
