// Owns the payments-upto catalogs: which port call a failure happened in, the fields of a seller's
// own payment description, and the ledger file bounds and timing.
import { TRANSACTION_SIZE_LIMIT } from '@solana/kit';
import { UPTO_WITHDRAW_STEPS } from 'x402-upto-metered';

export const PAYMENT_PHASES = { ADMIT: 'admit', SETTLE: 'settle' } as const;
export const BUYER_OBSERVATION = { maxResponseBytes: 1024 * 1024 } as const;
export const BATCH_BUYER_CHECKPOINTS = {
  DECLINED_REQUEST: 'gyblos:request:declined',
  OPENING_SENT: 'gyblos:opening:sent',
  OPENING_ABSENT: 'gyblos:opening:absent',
  OPENING_TRANSACTION: 'gyblos:opening:transaction',
  OPENING_VOUCHER: 'gyblos:opening:voucher',
  WITHDRAWAL: 'gyblos:withdrawal',
  WITHDRAWAL_INTENT: 'gyblos:withdrawal:intent',
} as const;
export const UPTO_BUYER_DISTINCT_PARTIES = 4;
export const BUYER_OBSERVATION_RPC_METHODS = [
  'getLatestBlockhash',
  'getSlot',
  'getGenesisHash',
  'getEpochInfo',
  'getSignaturesForAddress',
  'getTransaction',
  'getAccountInfo',
  'minimumLedgerSlot',
  'getFirstAvailableBlock',
  'isBlockhashValid',
] as const;
export const BUYER_RECOVERY_RPC_METHODS = [
  ...BUYER_OBSERVATION_RPC_METHODS,
  'getBlockTime',
  'sendTransaction',
  'getSignatureStatuses',
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
  // 5 adds withdrawal attempts; 4 records network; 3 policy; 2 slot and lifetime.
  version: 5,
  networkVersion: 4,
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

// Bound the SDK opening far below the journal capacity; use the SDK's Solana packet limit.
export const BATCH_OPENING_LIMITS = {
  bytes: 8 * 1024,
  transactionBytes: TRANSACTION_SIZE_LIMIT,
  transactionBase64Chars: Math.ceil(TRANSACTION_SIZE_LIMIT / 3) * 4,
} as const;

// Private catalog format, independent of wire/session record versions.
export const BATCH_POOL_VERSION = 1;
// Private block checkpoints do not change the native memo, voucher or existing v1 session record.
export const BATCH_BLOCK_STATE = { version: 2 } as const;
// Closed generations stay in the same atomic journal; neither count nor bytes may grow without bound.
export const BATCH_RENEWAL_STATE = { version: 3, maxHistory: 16 } as const;
// Financial admission is active-channel bounded; a separate finite index retains closed-buyer proof.
export const BATCH_SELLER_REGISTRY = {
  version: 1,
  maxBuyers: 64,
  stateBytes: 128 * 1024,
} as const;

// Stable BatchError codes from the pinned @x402/svm SDK, which does not export its catalog.
export const BATCH_SDK_DIAGNOSTIC_CODES = [
  'invalid_batch_settlement_svm_payload_type',
  'invalid_batch_settlement_svm_payment_flow',
  'invalid_batch_settlement_svm_token_program',
  'invalid_batch_settlement_svm_voucher_signature',
  'invalid_batch_settlement_svm_channel_id_mismatch',
  'invalid_batch_settlement_svm_fee_payer_mismatch',
  'invalid_batch_settlement_svm_receiver_authorizer_mismatch',
  'invalid_batch_settlement_svm_receiver_binding_unavailable',
  'invalid_batch_settlement_svm_delegated_unauthenticated',
  'invalid_batch_settlement_svm_close_authorization',
  'invalid_batch_settlement_svm_close_amount_unsupported',
  'invalid_batch_settlement_svm_close_state',
  'invalid_batch_settlement_svm_channel_closing',
  'invalid_batch_settlement_svm_withdraw_delay_mismatch',
  'invalid_batch_settlement_svm_withdraw_delay_out_of_range',
  'invalid_batch_settlement_svm_cumulative_amount_mismatch',
  'invalid_batch_settlement_svm_cumulative_exceeds_deposit',
  'invalid_batch_settlement_svm_voucher_expiry',
  'invalid_batch_settlement_svm_setup_transaction',
  'invalid_batch_settlement_svm_settlement_simulation',
  'invalid_batch_settlement_svm_deposit_below_min_deposit',
  'invalid_batch_settlement_svm_channel_state',
  'invalid_batch_settlement_svm_refund_transaction',
  'invalid_batch_settlement_svm_payout_attribution_ambiguous',
] as const;

// Set on a seller opening failure whose release could not be written, so the host can record it
// separately while the opening failure stays the reported error.
export const OPENING_RELEASE_FAILED = Symbol.for(
  'gyblos.batch.openingReleaseFailed',
);
