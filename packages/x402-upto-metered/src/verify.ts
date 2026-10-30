// The seller side's local check: the x402 upto facilitator verifies a channel open against the
// terms without any network call (only the fee payer's address is consulted).
import type { KeyPairSigner } from '@solana/kit';
import type { PaymentPayload } from '@x402/core/types';
import type { FacilitatorSvmSigner } from '@x402/svm';
import { UptoSvmScheme as UptoFacilitatorScheme } from '@x402/svm/upto/facilitator';

import { decodeUptoPayload } from './authorization';
import { UPTO } from './constants';
import { uptoRequirements } from './requirements';
import type { UptoAuthorization, UptoTerms } from './types';

function offline(): never {
  throw new Error('This verifier never reaches the network.');
}

// Only the calls verify makes are answered; any other call fails before touching a network.
function verifyingSigner(feePayer: KeyPairSigner): FacilitatorSvmSigner {
  return {
    getAddresses: () => [feePayer.address],
    getSigner: () => feePayer,
    signTransaction: offline,
    simulateTransaction: offline,
    sendTransaction: offline,
    confirmTransaction: offline,
    // Required by the facilitator's constructor; verify itself never calls them.
    getAccountInfo: offline,
    getLatestBlockhash: offline,
    getSlot: offline,
  };
}

// Vouchers are signed by the seller's authorizer at settlement, not here; only the fee payer's
// address takes part in verifying a channel open. The open's slot is checked against `slot()` when
// given (the chain's current slot); offline, against the open's own slot, leaving freshness to the
// chain, which refuses a stale open at deposit.
export function createUptoVerifier(
  feePayer: KeyPairSigner,
  options: { slot?: () => Promise<bigint> } = {},
) {
  const facilitator = new UptoFacilitatorScheme(verifyingSigner(feePayer));
  return async (
    authorization: UptoAuthorization,
    terms: UptoTerms,
  ): Promise<boolean> => {
    try {
      const payload = decodeUptoPayload(authorization);
      if (
        payload.channelId !== authorization.channelId ||
        payload.maxAmount !== authorization.maxAtomic
      )
        return false;
      const base = uptoRequirements(terms);
      const recentSlot = options.slot
        ? String(await options.slot())
        : String(payload.openSlot);
      const requirements = {
        ...base,
        extra: { ...base.extra, recentSlot },
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
