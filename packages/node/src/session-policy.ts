// Buyer-authorized reusable-session limits, independent of each quote's request ceiling.
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { PaymentSessionTerms } from '@gyblos/protocol/payment-session';

export interface BuyerSessionPolicy {
  depositAtomic: string;
  lifetimeMs: number;
  withdrawDelaySeconds: number;
}
export function parseBuyerSessionPolicy(_value: unknown): BuyerSessionPolicy | undefined {
  return undefined;
}
export function sessionTerms(_quote: SignedOfferV2, _policy: BuyerSessionPolicy, _now: number): PaymentSessionTerms | undefined {
  return undefined;
}
