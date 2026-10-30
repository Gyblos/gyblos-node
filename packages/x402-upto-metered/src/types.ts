// The package's own vocabulary for one metered upto payment; no Gyblos or transport types. A host
// adapter maps them onto its own ports (in Gyblos: PaymentAuthorization, PaymentAdmission and
// PaymentSettlement in @gyblos/protocol/payment, which add the request binding and fee shares).
import type { Network } from '@x402/core/types';

import type { UptoChannelState, UptoDepositState } from './constants';

// One recipient of each charge, in basis points; the first is always payTo.
export interface UptoSplit {
  recipient: string;
  bps: number;
}

// Everything that binds a deposit: who is paid, in what, up to how much and until when.
// The seller builds these from its own issued offer, never from the buyer's request.
export interface UptoTerms {
  network: Network;
  asset: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  tokenProgram: string;
  maxAtomic: string;
  // Epoch milliseconds after which the seller no longer admits the authorization.
  expiresAt: number;
  // The application binding the payer's wallet signs (for example a digest of these terms).
  memo: string;
  withdrawDelaySeconds: number;
  maxTimeoutSeconds: number;
  // How each charge is distributed; absent means all of it to payTo.
  splits?: readonly UptoSplit[];
  // An application reference kept with the channel record (for example the request it pays for).
  reference?: string;
}

// Recent-block hints the payer supplies so the channel open is built without a network call.
export interface UptoClientHints {
  recentBlockhash: string;
  lastValidBlockHeight: string;
  recentSlot: string;
}

// The payer's signed channel open, carried by any transport; payload is opaque base64.
export interface UptoAuthorization {
  channelId: string;
  payer: string;
  maxAtomic: string;
  payload: string;
}

export type UptoAdmission = Omit<UptoAuthorization, 'payload'>;

export interface UptoSettlement {
  channelId: string;
  chargedAtomic: string;
  refundedAtomic: string;
  transaction: string;
}

export interface UptoChannelRecord extends UptoAdmission {
  state: UptoChannelState;
  // The payer's signed open and the terms it was admitted under; a claim needs both.
  payload: string;
  terms: UptoTerms;
  // Present from SETTLING on: the only charge this channel may ever settle.
  chargedAtomic?: string;
  settlement?: UptoSettlement;
}

// The chain operations the seller drives. verify is local; deposit and claim broadcast.
// deposit throws UptoError(FACILITATOR_REJECTED) only when nothing landed (for example an unfunded
// payer); any other failure is ambiguous and depositState later tells whether it landed. claim is
// idempotent per channel and charge: repeating it returns the original transaction, never a second
// claim, and a different charge on a claimed channel is refused. The SDK alone does not give this
// across a crash (its pending-settlement entry is dropped once a claim confirms), so a real chain
// keeps its own durable claim record per channel or reads the claim back from the chain.
export interface UptoChain {
  verify(authorization: UptoAuthorization, terms: UptoTerms): Promise<boolean>;
  deposit(
    authorization: UptoAuthorization,
    terms: UptoTerms,
  ): Promise<{ transaction: string }>;
  depositState(channelId: string): Promise<UptoDepositState>;
  claim(
    record: UptoChannelRecord,
    chargedAtomic: string,
  ): Promise<{ transaction: string }>;
}

// The fields of the SDK's upto payload this package reads; the rest stays opaque.
export interface UptoPayloadFields {
  channelId: string;
  from: string;
  maxAmount: string;
  openSlot: string;
}

// Durable per-channel records; put replaces the record for its channelId.
export interface UptoStore {
  get(channelId: string): Promise<UptoChannelRecord | undefined>;
  put(record: UptoChannelRecord): Promise<void>;
  list(): Promise<UptoChannelRecord[]>;
}

// What the SDK-backed chain remembers durably per channel: when a deposit was sent, the one charge
// claimed and its transaction, and every broadcast signature the SDK asked to keep.
export interface UptoDepositRecord {
  channelId: string;
  sentAt: number;
}
export interface UptoClaimRecord {
  channelId: string;
  chargedAtomic: string;
  transaction?: string;
}
export interface UptoChainStore {
  getDeposit(channelId: string): Promise<UptoDepositRecord | undefined>;
  putDeposit(record: UptoDepositRecord): Promise<void>;
  getClaim(channelId: string): Promise<UptoClaimRecord | undefined>;
  putClaim(record: UptoClaimRecord): Promise<void>;
  getPending(key: string): Promise<string | undefined>;
  putPending(key: string, signature: string): Promise<void>;
  deletePending(key: string): Promise<void>;
}
