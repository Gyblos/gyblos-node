// Maps Gyblos payment terms onto x402-upto-metered terms: the memo is the payer-signed terms digest,
// the distribution splits each charge between payTo and the protocol fee treasury, and the request
// digest is kept as the channel's reference.
import type { UptoSellerOptions, UptoTerms } from 'x402-upto-metered';

import type {
  PaymentDescription,
  PaymentTerms,
} from '@gyblos/protocol/payment';
import { paymentMemo, paymentSplits } from '@gyblos/protocol/payment-binding';

// Channel parameters the seller fixes once for all its offers.
export interface UptoChannelSettings {
  tokenProgram: string;
  withdrawDelaySeconds: number;
  maxTimeoutSeconds: number;
}

// Gyblos networks are CAIP-2 ids ("solana:<genesis>"), the shape x402 calls a Network.
function networkOf(network: string): UptoTerms['network'] {
  const [namespace, reference] = network.split(':');
  return `${namespace}:${reference}`;
}

// The fields of every channel this seller opens; a request naming anything else is not for it.
export function uptoSellerTerms(
  description: PaymentDescription,
  settings: UptoChannelSettings,
): UptoSellerOptions['own'] {
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
