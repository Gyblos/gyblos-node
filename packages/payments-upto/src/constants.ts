// Owns the payments-upto catalogs: which port call a failure happened in, the fields of a seller's
// own payment description, and the ledger file bounds and timing.
import { UPTO_WITHDRAW_STEPS } from 'x402-upto-metered';

export const PAYMENT_PHASES = { ADMIT: 'admit', SETTLE: 'settle' } as const;
export const BUYER_OBSERVATION = { maxResponseBytes: 1024 * 1024 } as const;
export const UPTO_BUYER_DISTINCT_PARTIES = 4;
export const BUYER_OBSERVATION_RPC_METHODS = [
  'getGenesisHash',
  'getEpochInfo',
  'getSignaturesForAddress',
  'getTransaction',
  'getAccountInfo',
  'minimumLedgerSlot',
  'getFirstAvailableBlock',
] as const;
export type PaymentPhase = (typeof PAYMENT_PHASES)[keyof typeof PAYMENT_PHASES];

// Every PaymentDescription field; terms naming another value for any of them are not this seller's.
export const DESCRIPTION_FIELDS = [
  'network',
  'mint',
  'payTo',
  'feePayer',
  'authorizer',
  'protocolFeeBps',
  'treasury',
] as const;

export const LEDGER_FILE = {
  version: 1,
  // The whole ledger document; a seller's open and recent channels fit far below this.
  maxBytes: 8 * 1024 * 1024,
  // Finished channels are kept at least this long: far past any terms expiry, so a pruned channel's
  // authorization can no longer be admitted again.
  minRetentionMs: 86_400_000,
  // A new channel is refused once the document is this large, so the channels already open can
  // always still record their claims within maxBytes.
  // Half the bound: every open channel's remaining records (attempts, claim, pending) still fit.
  newChannelBytes: 4 * 1024 * 1024,
} as const;

// The seller's chain wiring: how long a sent open can still land (its blockhash lifetime, with margin),
// and how many channels the ledger keeps.
export const UPTO_SELLER = {
  openWindowMs: 90_000,
  // A ceiling on the record count; the byte bound (LEDGER_FILE.newChannelBytes) usually binds first.
  maxChannels: 10_000,
} as const;

// The buyer's journal of authorized channels: one small private document. Settled entries are kept
// long past any channel's lifetime, then pruned; open ones are never dropped.
export const BUYER_JOURNAL = {
  // 4 records the network; 3 records mint, fee treasury and rate; 2 records slot and lifetime.
  version: 4,
  policyVersion: 3,
  slotVersion: 2,
  legacyVersion: 1,
  // maxEntries entries of the widest form fit, with room to spare.
  maxBytes: 2 * 1024 * 1024,
  maxEntries: 2_000,
  settledRetentionMs: 30 * 86_400_000,
} as const;

// Why a signed open is not eligible for recovery on this network.
export const NETWORK_RECOVERY_BLOCKS = {
  UNKNOWN: 'unknown',
  MISMATCH: 'mismatch',
} as const;
export type NetworkRecoveryBlock =
  (typeof NETWORK_RECOVERY_BLOCKS)[keyof typeof NETWORK_RECOVERY_BLOCKS];

export const RECONCILE_OUTCOMES = {
  // The chain charged exactly the buyer's own count.
  SETTLED: 'settled',
  // The chain charged another amount; recorded as a dispute, no longer blocking.
  DISPUTED: 'disputed',
  // The chain shows a charge but the buyer's own count was not kept.
  UNCHECKED: 'unchecked',
  // The open provably never landed (blockhash expired, no deposit, no account): nothing was charged.
  NEVER_OPENED: 'never-opened',
  // Still open, or its open may still land: it keeps blocking payments.
  OPEN: 'open',
} as const;
// What a withdrawal run did with each open channel: the chain step taken, or why it waited.
export const WITHDRAW_STEPS = {
  ...UPTO_WITHDRAW_STEPS,
  // The seller may still claim it with the buyer's authorization; it is left alone until it cannot.
  CLAIMABLE: 'claimable',
  // This channel's step failed (its code says why); the run went on with the others.
  FAILED: 'failed',
} as const;
export const BUYER_WITHDRAW = {
  // Past the payload's own lifetime, room for a claim the seller sent just before it ran out to land
  // (a blockhash lives about 90 s) and for the seller's clock running behind the buyer's.
  claimMarginMs: 150_000,
  msPerSecond: 1_000,
  // When a failed channel is worth trying again.
  failedRetrySeconds: 30,
} as const;

// Bounded private reusable-channel journal; never aliases the legacy per-request journal.
export const REUSABLE_CONTROL = {
  // Base64 expansion of the maximum Solana wire transaction size.
  maxEncodedWireBytes: 1644,
  version: 1,
  preparing: 'preparing',
  pending: 'pending',
  confirmed: 'confirmed',
  failed: 'failed',
  unknown: 'unknown',
} as const;

export const REUSABLE_JOURNAL = {
  version: 1,
  maxChannels: 256,
  maxVouchersPerChannel: 256,
  maxBytes: 2 * 1024 * 1024,
  signatureChars: 90,
  signatureBytes: 64,
  addressBytes: 32,
  voucherBytes: 50,
  voucherAmountOffset: 34,
  voucherPrefix: 86,
  voucherVersion: 1,
  maxGracePeriod: 0xffff_ffff,
} as const;
export const REUSABLE_JOURNAL_STATES = {
  PREPARING: 'preparing',
  OPENING: 'opening',
  READY: 'ready',
  NOT_OPENED: 'not-opened',
  CLOSED: 'closed',
  CLOSED_REDIRECTED: 'closed-redirected',
} as const;

// Layout of the pinned payment-channel program's open instruction, used before signing.
export const REUSABLE_OPEN_WIRE = {
  discriminator: 1,
  maxMessageBytes: 1232,
  saltOffset: 1,
  depositOffset: 9,
  graceOffset: 17,
  slotOffset: 21,
  countOffset: 29,
  recipientsOffset: 33,
  recipientBytes: 34,
  channelAccountIndex: 5,
  tokenProgramAccountIndex: 8,
  seed: 'channel',
  memoProgram: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  computeBudgetProgram: 'ComputeBudget111111111111111111111111111111',
  computeLimit: 200_000,
  instructionCount: 4,
  // Maximum open epoch window of the pinned program; the reader must verify the deployed binary.
  openSlotWindow: 1_500,
  computeLimitTag: 2,
  computePriceTag: 3,
  computeLimitBytes: 5,
  computePriceBytes: 9,
} as const;
