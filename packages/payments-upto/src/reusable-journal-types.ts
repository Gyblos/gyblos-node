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
  vouchers: ReusableVoucher[];
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
  historyThroughSlot: string;
  blockHeightContextSlot: string;
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
