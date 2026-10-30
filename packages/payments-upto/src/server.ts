// The PaymentServer port over x402-upto-metered: admits a buyer's channel open only for terms that are
// this seller's own (description, fee and treasury) and name the authorization's payer and request,
// and settles exactly the recorded channel, reporting the seller and fee shares of the charge.
import type { UptoSeller } from 'x402-upto-metered';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentDescription,
  type PaymentServer,
} from '@gyblos/protocol/payment';
import { settlementShares } from '@gyblos/protocol/payment-binding';

import { PAYMENT_PHASES, paymentFailure } from './errors';
import { uptoTermsFor, type UptoChannelSettings } from './terms';

export interface UptoPaymentServerOptions {
  description: PaymentDescription;
  settings: UptoChannelSettings;
  seller: UptoSeller;
}

function mismatch(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
}

export function createUptoPaymentServer(
  options: UptoPaymentServerOptions,
): PaymentServer {
  const { description, settings, seller } = options;
  const own = Object.keys(description) as (keyof PaymentDescription)[];
  return {
    describe: async () => ({ ...description }),
    async admit(authorization, terms, admitOptions = {}) {
      // Fails fast on foreign terms; the payer-signed memo would also refuse them at verify.
      if (
        !own.every((key) => terms[key] === description[key]) ||
        terms.buyer !== authorization.payer ||
        terms.requestDigest !== authorization.requestDigest
      )
        return mismatch();
      try {
        const admitted = await seller.admit(
          authorization,
          await uptoTermsFor(terms, settings),
          admitOptions,
        );
        return { ...admitted, requestDigest: terms.requestDigest };
      } catch (error) {
        return paymentFailure(error, PAYMENT_PHASES.ADMIT);
      }
    },
    async settle(admission: PaymentAdmission, chargedAtomic) {
      try {
        const record = await seller.record(admission.channelId);
        if (
          !record ||
          record.payer !== admission.payer ||
          record.maxAtomic !== admission.maxAtomic ||
          record.terms.reference !== admission.requestDigest
        )
          return mismatch();
        const settled = await seller.settle(admission.channelId, chargedAtomic);
        return {
          ...settled,
          ...settlementShares(chargedAtomic, description.protocolFeeBps),
        };
      } catch (error) {
        return paymentFailure(error, PAYMENT_PHASES.SETTLE);
      }
    },
  };
}
