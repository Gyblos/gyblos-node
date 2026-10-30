// The package's own vocabulary for one metered upto payment; no Gyblos or transport types.
import type { UptoChannelState } from './constants';

// Everything that binds a deposit: who is paid, in what, up to how much and until when.
export interface UptoTerms {
  network: string;
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
  // Present from SETTLING on: the only charge this channel may ever settle.
  chargedAtomic?: string;
  settlement?: UptoSettlement;
}

// The chain operations the seller drives. verify is local; deposit and claim broadcast.
export interface UptoChain {
  verify(authorization: UptoAuthorization, terms: UptoTerms): Promise<boolean>;
  deposit(
    authorization: UptoAuthorization,
    terms: UptoTerms,
  ): Promise<{ transaction: string }>;
  claim(
    record: UptoChannelRecord,
    chargedAtomic: string,
  ): Promise<{ transaction: string }>;
}

// Durable per-channel records; put replaces the record for its channelId.
export interface UptoStore {
  get(channelId: string): Promise<UptoChannelRecord | undefined>;
  put(record: UptoChannelRecord): Promise<void>;
}
