// Owns the payment terms digest, the channel-open memo that carries it, and the protocol fee
// arithmetic. Pure functions over Gyblos-owned types: no SDK, chain, clock or configuration.
import { PAYMENT_BINDING, PAYMENT_ERROR_CODES } from './constants';
import { PaymentError, type PaymentTerms } from './payment';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DENOMINATOR = BigInt(PAYMENT_BINDING.bpsDenominator);

function untrusted(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}

function feeBps(value: number): bigint {
  return Number.isInteger(value) &&
    value >= 0 &&
    value <= PAYMENT_BINDING.maxFeeBps
    ? BigInt(value)
    : untrusted();
}

function atomic(value: string): bigint {
  return ATOMIC.test(value) ? BigInt(value) : untrusted();
}

// SHA-256 over every field of the terms, so the payer's signature on the memo covers them all.
export async function paymentTermsDigest(terms: PaymentTerms): Promise<string> {
  feeBps(terms.protocolFeeBps);
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(PAYMENT_BINDING.termsDomain, terms),
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

// On-chain shares of each charge. The seller's share is rounded up, so with the gross price it
// never receives less than its own price; the treasury takes the remainder.
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
