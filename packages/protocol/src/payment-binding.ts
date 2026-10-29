// Owns the payment terms digest, the channel-open memo that carries it, and the protocol fee
// arithmetic: the buyer's gross price, the channel distribution and each charge's shares.
// Pure functions over Gyblos-owned types: no SDK, chain, clock or configuration.
import { PAYMENT_BINDING, PAYMENT_ERROR_CODES } from './constants';
import { PaymentError, type PaymentSplit, type PaymentTerms } from './payment';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DENOMINATOR = BigInt(PAYMENT_BINDING.bpsDenominator);

function untrusted(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}

function feeBps(value: unknown): bigint {
  return Number.isInteger(value) &&
    typeof value === 'number' &&
    value >= 0 &&
    value <= PAYMENT_BINDING.maxFeeBps
    ? BigInt(value)
    : untrusted();
}

function atomic(value: unknown): bigint {
  return typeof value === 'string' && ATOMIC.test(value)
    ? BigInt(value)
    : untrusted();
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : untrusted();
}

// Exactly the money fields, typed: extra properties never reach the digest and a number where a
// decimal string belongs is refused rather than hashed differently.
function canonicalTerms(terms: PaymentTerms): PaymentTerms {
  if (!Number.isSafeInteger(terms.expiresAt)) untrusted();
  atomic(terms.maxAtomic);
  feeBps(terms.protocolFeeBps);
  return {
    buyer: text(terms.buyer),
    network: text(terms.network),
    mint: text(terms.mint),
    payTo: text(terms.payTo),
    feePayer: text(terms.feePayer),
    authorizer: text(terms.authorizer),
    requestDigest: text(terms.requestDigest),
    maxAtomic: terms.maxAtomic,
    expiresAt: terms.expiresAt,
    protocolFeeBps: terms.protocolFeeBps,
    treasury: text(terms.treasury),
  };
}

// SHA-256 over every field of the terms, so the payer's signature on the memo covers them all.
export async function paymentTermsDigest(terms: PaymentTerms): Promise<string> {
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(PAYMENT_BINDING.termsDomain, canonicalTerms(terms)),
      ),
    ),
  );
}

export async function paymentMemo(terms: PaymentTerms): Promise<string> {
  return `${PAYMENT_BINDING.memoPrefix}${await paymentTermsDigest(terms)}`;
}

// The price a buyer sees and pays: the seller's price plus the fee, rounded up to whole units.
export function grossAtomicPerMtok(
  netAtomicPerMtok: string,
  protocolFeeBps: number,
): string {
  const gross =
    atomic(netAtomicPerMtok) * (DENOMINATOR + feeBps(protocolFeeBps));
  return String((gross + DENOMINATOR - 1n) / DENOMINATOR);
}

// Basis points of each charge. The seller's share is rounded up, so its floored share of a charge
// priced at the gross rate is never below its own price rounded down to the atomic unit.
export function feeSplitBps(protocolFeeBps: number): {
  sellerBps: number;
  treasuryBps: number;
} {
  const total = DENOMINATOR + feeBps(protocolFeeBps);
  const sellerBps = Number((DENOMINATOR * DENOMINATOR + total - 1n) / total);
  return {
    sellerBps,
    treasuryBps: PAYMENT_BINDING.bpsDenominator - sellerBps,
  };
}

// The only channel distribution admit may accept for these terms; no treasury entry without a fee.
export function paymentSplits(terms: PaymentTerms): PaymentSplit[] {
  const { sellerBps, treasuryBps } = feeSplitBps(terms.protocolFeeBps);
  return [
    { recipient: text(terms.payTo), bps: sellerBps },
    ...(treasuryBps
      ? [{ recipient: text(terms.treasury), bps: treasuryBps }]
      : []),
  ];
}

// What payTo and treasury receive for one charge: each share floored, as the program pays it.
export function settlementShares(
  chargedAtomic: string,
  protocolFeeBps: number,
): { sellerAtomic: string; feeAtomic: string } {
  const charged = atomic(chargedAtomic);
  const { sellerBps, treasuryBps } = feeSplitBps(protocolFeeBps);
  return {
    sellerAtomic: String((charged * BigInt(sellerBps)) / DENOMINATOR),
    feeAtomic: String((charged * BigInt(treasuryBps)) / DENOMINATOR),
  };
}
