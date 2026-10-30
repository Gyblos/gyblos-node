// The seller side's local check: the x402 upto facilitator verifies a channel open against the
// terms without any network call; only the fee payer's address takes part, never its key.
import { createNoopSigner, type Address } from '@solana/kit';
import type { PaymentPayload } from '@x402/core/types';
import type { FacilitatorSvmSigner } from '@x402/svm';
import { UptoSvmScheme as UptoFacilitatorScheme } from '@x402/svm/upto/facilitator';

import { decodeUptoPayload } from './authorization';
import { UPTO, UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import { uptoRequirements } from './requirements';
import type { UptoAuthorization, UptoTerms } from './types';

function offline(): never {
  throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
}

// Only the calls verify makes are answered; the constructor requires the others, which fail.
function verifyingSigner(feePayer: Address): FacilitatorSvmSigner {
  return {
    getAddresses: () => [feePayer],
    getSigner: () => createNoopSigner(feePayer),
    signTransaction: offline,
    simulateTransaction: offline,
    sendTransaction: offline,
    confirmTransaction: offline,
    getAccountInfo: offline,
    getLatestBlockhash: offline,
    getSlot: offline,
  };
}

export type UptoVerifier = (
  authorization: UptoAuthorization,
  terms: UptoTerms,
) => Promise<boolean>;

// `slot` is the chain's current slot: the facilitator refuses an open whose slot is outside its
// freshness window. Vouchers are signed by the seller's authorizer at settlement, not here.
export function createUptoVerifier(
  feePayer: Address,
  slot: () => Promise<bigint>,
): UptoVerifier {
  const facilitator = new UptoFacilitatorScheme(verifyingSigner(feePayer));
  return async (authorization, terms) => {
    try {
      const payload = decodeUptoPayload(authorization);
      if (
        payload.channelId !== authorization.channelId ||
        payload.maxAmount !== authorization.maxAtomic
      )
        return false;
      const base = uptoRequirements(terms);
      const requirements = {
        ...base,
        extra: { ...base.extra, recentSlot: String(await slot()) },
      };
      const paymentPayload: PaymentPayload = {
        x402Version: UPTO.x402Version,
        accepted: requirements,
        payload,
      };
      const verdict = await facilitator.verify(paymentPayload, requirements);
      // The facilitator reports the payer it verified; it must be the one the authorization names.
      return verdict.isValid && verdict.payer === authorization.payer;
    } catch {
      return false;
    }
  };
}
