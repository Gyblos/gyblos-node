// Owns the SDK-independent payment ports (PaymentClient for buyers, PaymentServer for sellers) and
// their uniform failure. Amounts are decimal atomic strings, as on the v2 wire. No SDK, chain or transport.
//
// Money rules every implementation keeps (tests/support/payment-contract.ts):
// 1. authorize rejects untrusted terms before writing the journal or signing anything, and the
//    signature binds every field of the terms, so no other seller or request can use it;
// 2. the journal entry is written before the only signature for a requestDigest, never re-signed,
//    even under concurrent calls;
// 3. admit takes the terms from the seller's own issued offer, never from the buyer, and rejects
//    an authorization that does not match them or reuses a channel, moving no funds;
// 4. settle trusts only the server's own channel record, charges at most the ceiling, refunds the
//    rest, and settles once (repeating the same charge returns the same settlement);
// 5. checkReceipt verifies the settlement on the ledger, not the seller's word;
// 6. every failure is a PaymentError whose message is its static code.
import type { PaymentChannelState, PaymentErrorCode } from './constants';
import type { InferenceOfferV2 } from './control-types';

// The message is the static code; RPC URLs, keys and upstream text never reach it.
export class PaymentError extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(code);
    this.name = 'PaymentError';
  }
}

// What a seller declares before quoting: where and in what asset it is paid.
export type PaymentDescription = Pick<
  InferenceOfferV2,
  'network' | 'mint' | 'payTo' | 'feePayer' | 'authorizer'
>;

// The money-binding fields of a signed v2 offer. The buyer verifies the offer signature first
// (payTo, feePayer and authorizer are the seller's own choice); network, mint, buyer and the ceiling
// are then checked against the buyer's policy by authorize.
export type PaymentTerms = PaymentDescription &
  Pick<InferenceOfferV2, 'buyer' | 'requestDigest' | 'maxAtomic' | 'expiresAt'>;

// The buyer's signed deposit of maxAtomic for one request; payload is the scheme's opaque proof.
export interface PaymentAuthorization {
  channelId: string;
  payer: string;
  requestDigest: string;
  maxAtomic: string;
  payload: string;
}

// A verified, deposited channel the seller may now serve and later settle.
export type PaymentAdmission = Omit<PaymentAuthorization, 'payload'>;

export interface PaymentSettlement {
  channelId: string;
  chargedAtomic: string;
  refundedAtomic: string;
  transaction: string;
}

export interface PaymentReconciliation {
  channelId: string;
  requestDigest: string;
  state: PaymentChannelState;
  chargedAtomic: string | null;
}

export interface PaymentClient {
  authorize(terms: PaymentTerms): Promise<PaymentAuthorization>;
  // Accepts a settlement only if the ledger shows it charging what the buyer itself metered and
  // refunding the rest; records it in the journal.
  checkReceipt(
    authorization: PaymentAuthorization,
    settlement: PaymentSettlement,
    expectedChargedAtomic: string,
  ): Promise<void>;
  reconcile(): Promise<PaymentReconciliation[]>;
}

export interface PaymentServer {
  describe(): Promise<PaymentDescription>;
  admit(
    authorization: PaymentAuthorization,
    terms: PaymentTerms,
  ): Promise<PaymentAdmission>;
  settle(
    admission: PaymentAdmission,
    chargedAtomic: string,
  ): Promise<PaymentSettlement>;
}
