// Owns the SDK-independent payment ports (PaymentClient for buyers, PaymentServer for sellers) and
// their uniform failure. Amounts are decimal atomic strings, as on the v2 wire. No SDK, chain or transport.
//
// Money rules every implementation keeps (tests/support/payment-contract.ts; a fee change while a
// channel is open is covered per adapter, since the contract keeps one configuration):
// 1. authorize rejects untrusted terms before writing the journal or signing anything, and the
//    signature binds every field of the terms, so no other seller or request can use it;
// 2. the journal entry is written before the only signature for a requestDigest, never re-signed,
//    even under concurrent calls;
// 3. admit takes the terms from the seller's own issued offer, never from the buyer, and rejects,
//    in this order, an authorization that does not match them (including a channel distribution
//    other than paymentSplits(terms)), a channel already opened, and terms
//    that expired before the deposit is sent, moving no funds; a caller abort is honoured only
//    until the deposit is sent, after which admission completes and returns the admission;
// 4. settle trusts only the server's own channel record, charges at most the ceiling, refunds the
//    rest, and settles once (repeating the same charge returns the same settlement); a claim the
//    chain refuses for good is SETTLEMENT_LAPSED (nothing charged), distinct from a retryable
//    UNAVAILABLE that may still land, and the reported shares are those the signed distribution pays;
// 5. checkReceipt verifies the settlement on the ledger, not the seller's word, including the
//    seller and fee shares actually paid (fixed by the distribution the buyer signed at open);
// 6. every failure is a PaymentError whose message is its static code, except that an aborted
//    caller signal rejects with signal.reason (as Engine.generate does).
import type { PaymentChannelState, PaymentErrorCode } from './constants';
import type { InferenceOfferV2 } from './control-types';

// The message is the static code; RPC URLs, keys and upstream text never reach it.
export class PaymentError extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(code);
    this.name = 'PaymentError';
  }
}

// The network's protocol fee, added on top of the seller's price and split on chain to treasury.
export interface PaymentFee {
  protocolFeeBps: number;
  treasury: string;
}

// What a seller declares before quoting: where and in what asset it is paid, and the fee it applies.
export type PaymentDescription = Pick<
  InferenceOfferV2,
  'network' | 'mint' | 'payTo' | 'feePayer' | 'authorizer'
> &
  PaymentFee;

// The money-binding fields of a signed v2 offer. The buyer verifies the offer signature first
// (payTo, feePayer and authorizer are the seller's own choice); network, mint, buyer and the ceiling
// are then checked against the buyer's policy by authorize, as are the fee and treasury, which come
// from network configuration on both sides rather than from the offer.
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
export type PaymentAdmission = Omit<PaymentAuthorization, 'payload'> & {
  // Adapter-verified voucher cutoff in epoch milliseconds, distinct from quote admission expiry.
  claimUntil: number;
};

// One recipient of a channel's on-chain distribution, in basis points of each charge.
export interface PaymentSplit {
  recipient: string;
  bps: number;
}

// sellerAtomic and feeAtomic are what payTo and treasury actually received; the program floors
// each share, so their sum may fall short of chargedAtomic by rounding dust.
export interface PaymentSettlement {
  channelId: string;
  chargedAtomic: string;
  refundedAtomic: string;
  sellerAtomic: string;
  feeAtomic: string;
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
  // Forgets an authorization the caller knows never left this process (nothing was sent), so it no
  // longer awaits reconciliation; the discarded open must never be sent afterwards.
  discard(authorization: PaymentAuthorization): Promise<void>;
}

export interface PaymentServer {
  describe(): Promise<PaymentDescription>;
  // The signal is honoured only until the deposit is sent; after that, admission runs to the end.
  admit(
    authorization: PaymentAuthorization,
    terms: PaymentTerms,
    options?: { signal?: AbortSignal; minClaimWindowMs?: number },
  ): Promise<PaymentAdmission>;
  settle(
    admission: PaymentAdmission,
    chargedAtomic: string,
  ): Promise<PaymentSettlement>;
}
