// Builds the x402 upto payment requirements both client and facilitator read from the same terms,
// so they agree byte for byte on what the channel open must contain.
import type { PaymentRequirements } from '@x402/core/types';

import { UPTO } from './constants';
import type { UptoClientHints, UptoTerms } from './types';

const MS_PER_SECOND = 1000;

export function uptoRequirements(
  terms: UptoTerms,
  hints?: UptoClientHints,
): PaymentRequirements {
  return {
    scheme: UPTO.scheme,
    network: terms.network as PaymentRequirements['network'],
    asset: terms.asset,
    amount: terms.maxAtomic,
    payTo: terms.payTo,
    maxTimeoutSeconds: terms.maxTimeoutSeconds,
    extra: {
      feePayer: terms.feePayer,
      receiverAuthorizer: terms.authorizer,
      withdrawDelay: terms.withdrawDelaySeconds,
      tokenProgram: terms.tokenProgram,
      memo: terms.memo,
      ...(hints ?? {}),
    },
  };
}

export function secondsOf(epochMs: number): number {
  return Math.floor(epochMs / MS_PER_SECOND);
}
