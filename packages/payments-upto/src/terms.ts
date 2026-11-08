// Maps Gyblos payment terms onto x402-upto-metered terms: the memo is the payer-signed terms digest,
// the distribution splits each charge between payTo and the protocol fee treasury, and the request
// digest is kept as the channel's reference.
import {
  UPTO_CLAIM_LIMITS,
  type UptoSellerOptions,
  type UptoTerms,
} from 'x402-upto-metered';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentDescription,
  type PaymentTerms,
} from '@gyblos/protocol/payment';
import { paymentMemo, paymentSplits } from '@gyblos/protocol/payment-binding';

// Channel parameters the seller fixes once for all its offers.
export interface UptoChannelSettings {
  tokenProgram: string;
  withdrawDelaySeconds: number;
  maxTimeoutSeconds: number;
}

// Gyblos networks are CAIP-2 ids ("solana:<genesis>"), the shape x402 calls a Network; anything
// else is refused, never truncated.
function networkOf(network: string): UptoTerms['network'] {
  const [namespace, reference, ...rest] = network.split(':');
  if (!namespace || !reference || rest.length)
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  return `${namespace}:${reference}`;
}

// The fields of every channel this seller opens; a request naming anything else is not for it.
export function uptoSellerTerms(
  description: PaymentDescription,
  settings: UptoChannelSettings,
): UptoSellerOptions['own'] {
  if (
    !Number.isSafeInteger(settings.maxTimeoutSeconds) ||
    settings.maxTimeoutSeconds <= 0 ||
    !Number.isSafeInteger(settings.withdrawDelaySeconds) ||
    settings.withdrawDelaySeconds <=
      settings.maxTimeoutSeconds + UPTO_CLAIM_LIMITS.sdkExpirySkewSeconds
  )
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  return {
    network: networkOf(description.network),
    asset: description.mint,
    payTo: description.payTo,
    feePayer: description.feePayer,
    authorizer: description.authorizer,
    tokenProgram: settings.tokenProgram,
    withdrawDelaySeconds: settings.withdrawDelaySeconds,
  };
}

export async function uptoTermsFor(
  terms: PaymentTerms,
  settings: UptoChannelSettings,
): Promise<UptoTerms> {
  return {
    network: networkOf(terms.network),
    asset: terms.mint,
    payTo: terms.payTo,
    feePayer: terms.feePayer,
    authorizer: terms.authorizer,
    tokenProgram: settings.tokenProgram,
    maxAtomic: terms.maxAtomic,
    expiresAt: terms.expiresAt,
    memo: await paymentMemo(terms),
    withdrawDelaySeconds: settings.withdrawDelaySeconds,
    maxTimeoutSeconds: settings.maxTimeoutSeconds,
    splits: paymentSplits(terms),
    reference: terms.requestDigest,
  };
}
