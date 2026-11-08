// The PaymentServer port over x402-upto-metered: admits a buyer's channel open only for terms that are
// this seller's own (description, fee and treasury) and name the authorization's payer and request,
// and settles exactly the recorded channel, reporting the seller and fee shares of the charge.
import {
  uptoClaimUntil,
  type UptoChannelRecord,
  type UptoSeller,
} from 'x402-upto-metered';

import {
  PAYMENT_BINDING,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentDescription,
  type PaymentServer,
} from '@gyblos/protocol/payment';

import { DESCRIPTION_FIELDS, PAYMENT_PHASES } from './constants';
import { paymentFailure } from './errors';
import {
  assertMainnetPilotDeposit,
  assertPaymentNetworkEnabled,
} from './mainnet';
import {
  uptoSellerTerms,
  uptoTermsFor,
  type UptoChannelSettings,
} from './terms';

export interface UptoPaymentServerOptions {
  description: PaymentDescription;
  settings: UptoChannelSettings;
  seller: UptoSeller;
  now?: () => number;
}

// What the channel's signed distribution pays for this charge (each share floored, as the program
// pays it): the first recipient is payTo, the rest is the protocol fee. Independent of the
// seller's current fee setting, which may have changed since the channel opened.
function sharesPaid(record: UptoChannelRecord, chargedAtomic: string) {
  const charged = BigInt(chargedAtomic);
  const denominator = BigInt(PAYMENT_BINDING.bpsDenominator);
  const [seller, ...fee] = (record.terms.splits ?? []).map(
    (split) => (charged * BigInt(split.bps)) / denominator,
  );
  return {
    sellerAtomic: String(seller ?? charged),
    feeAtomic: String(fee.reduce((total, share) => total + share, 0n)),
  };
}

function mismatch(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
}

export function createUptoPaymentServer(
  options: UptoPaymentServerOptions,
): PaymentServer {
  const description = { ...options.description };
  const settings = { ...options.settings };
  const { seller } = options;
  const now = options.now ?? Date.now;
  assertPaymentNetworkEnabled(description.network);
  // Fails at construction on a malformed description rather than on the first request.
  uptoSellerTerms(description, settings);
  return {
    describe: async () => ({ ...description }),
    async admit(inputAuthorization, inputTerms, admitOptions = {}) {
      const authorization = { ...inputAuthorization };
      const terms = { ...inputTerms };
      // Fails fast on foreign terms; the payer-signed memo would also refuse them at verify.
      if (
        !DESCRIPTION_FIELDS.every((key) => terms[key] === description[key]) ||
        terms.buyer !== authorization.payer ||
        terms.requestDigest !== authorization.requestDigest
      )
        return mismatch();
      assertMainnetPilotDeposit(terms);
      assertMainnetPilotDeposit({
        network: terms.network,
        mint: terms.mint,
        maxAtomic: authorization.maxAtomic,
      });
      try {
        const claimUntil = uptoClaimUntil(authorization);
        const reserve = admitOptions.minClaimWindowMs ?? 0;
        if (!Number.isSafeInteger(reserve) || reserve < 0)
          throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
        if (claimUntil - now() <= reserve)
          throw new PaymentError(PAYMENT_ERROR_CODES.TERMS_EXPIRED);
        const admitted = await seller.admit(
          authorization,
          await uptoTermsFor(terms, settings),
          { ...admitOptions, minClaimWindowMs: reserve },
        );
        return { ...admitted, requestDigest: terms.requestDigest, claimUntil };
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
        return { ...settled, ...sharesPaid(record, chargedAtomic) };
      } catch (error) {
        return paymentFailure(error, PAYMENT_PHASES.SETTLE);
      }
    },
  };
}
