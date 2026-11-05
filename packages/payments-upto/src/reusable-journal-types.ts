// Persisted reusable-channel types and the facts required from an independent finalized reader.
import { REUSABLE_JOURNAL_STATES } from './constants';

export type ReusableJournalState =
  (typeof REUSABLE_JOURNAL_STATES)[keyof typeof REUSABLE_JOURNAL_STATES];
export interface ReusableChannelTerms {
  channelId: string;
  buyer: string;
  sellerNodeId: string;
  payTo: string;
  feePayer: string;
  treasury: string;
  mint: string;
  network: string;
  protocolFeeBps: number;
  depositAtomic: string;
  openSlot: string;
  lastValidBlockHeight: string;
  recentBlockhash: string;
  salt: string;
  gracePeriod: number;
  tokenProgram: string;
}
export interface ReusableVoucher {
  requestDigest: string;
  maxClaimableAmount: string;
  signature: string;
  bindingSignature: string;
}
export interface ReusablePending {
  requestDigest: string;
  maxClaimableAmount: string;
  bindingSignature: string;
}
export interface ReusableChannelEntry {
  terms: ReusableChannelTerms;
  status: ReusableJournalState;
  termsSignature: string;
  lastObservedSlot: string;
  authorizedAtomic: string;
  pending: ReusablePending | null;
  terminal: NeverOpenedRecord | null;
  closure: ReusableClosureRecord | null;
  vouchers: ReusableVoucher[];
}
export interface ReusableClosureRecord {
  contextSlot: string;
  escrowTokenAccount: string;
  programTreasuryOwner: string;
  settledAtomic: string;
  sellerReceivedAtomic: string;
  treasuryReceivedAtomic: string;
  programResidualAtomic: string;
  buyerRefundAtomic: string;
  buyerRefundRedirectedAtomic: string;
  sellerRedirectedAtomic: string;
  treasuryRedirectedAtomic: string;
  signature: string;
}
// A trusted archival reader must derive these totals from complete finalized token transfers.
export interface ClosedChannelObservation {
  finalized: boolean;
  network: string;
  program: string;
  programTreasuryOwner: string;
  escrowTokenAccount: string;
  channelId: string;
  mint: string;
  buyer: string;
  payTo: string;
  treasury: string;
  historyComplete: boolean;
  historyFromSlot: string;
  historyThroughSlot: string;
  finalizedTipSlot: string;
  channelClosed: boolean;
  escrowBalanceAtomic: string;
  depositedAtomic: string;
  settledAtomic: string;
  sellerReceivedAtomic: string;
  treasuryReceivedAtomic: string;
  programResidualAtomic: string;
  buyerRefundAtomic: string;
  buyerRefundOwner: string;
  redirectedAtomic: string;
  buyerRefundRedirectedAtomic: string;
  sellerRedirectedAtomic: string;
  treasuryRedirectedAtomic: string;
}
export interface NeverOpenedRecord {
  contextSlot: string;
  finalizedBlockHeight: string;
  signature: string;
}
export interface NeverOpenedObservation {
  network: string;
  channelId: string;
  finalized: boolean;
  programWindowVerified: boolean;
  contextSlot: string;
  finalizedTipSlot: string;
  finalizedBlockHeight: string;
  accountAbsent: boolean;
  historyComplete: boolean;
  noOpenTransaction: boolean;
  blockhash: string;
  blockhashValid: boolean;
  blockhashStatusFinalized: boolean;
  blockhashContextSlot: string;
  accountContextSlot: string;
  historyFromSlot: string;
  historyThroughSlot: string;
  blockHeightContextSlot: string;
}
// The reader must provide complete finalized buyer history from openSlot through the tip.
// It is a trusted archival reader, not evidence cryptographically proved by this API.
export interface PreparationObservation {
  network: string;
  buyer: string;
  memo: string;
  finalized: boolean;
  programWindowVerified: boolean;
  historyComplete: boolean;
  noMatchingOpen: boolean;
  historyFromSlot: string;
  historyThroughSlot: string;
  finalizedTipSlot: string;
  finalizedBlockHeight: string;
  blockHeightContextSlot: string;
  blockhash: string;
  blockhashValid: boolean;
  blockhashContextSlot: string;
}
export interface PreparedOpeningObservation {
  network: string;
  buyer: string;
  finalized: boolean;
  transactionSucceeded: boolean;
  transactionSlot: string;
  finalizedTipSlot: string;
  messageBytes: Uint8Array;
}
export interface FinalizedOpenObservation {
  channelId: string;
  network: string;
  programOwner: string;
  payer: string;
  payee: string;
  rentPayer: string;
  authorizedSigner: string;
  mint: string;
  tokenProgram: string;
  salt: string;
  openSlot: string;
  gracePeriod: number;
  depositAtomic: string;
  distributionHash: string;
  state: string;
  finalized: boolean;
  contextSlot: string;
  finalizedTipSlot: string;
  settledAtomic: string;
  paidAtomic: string;
}
