// Builds the x402 upto payment requirements both client and facilitator read from the same terms,
// so they agree byte for byte on what the channel open must contain.
import type { PaymentRequirements } from '@x402/core/types';

import { UPTO } from './constants';
import type { UptoClientHints, UptoTerms } from './types';

export function uptoRequirements(
  terms: UptoTerms,
  hints?: Partial<UptoClientHints>,
): PaymentRequirements {
  return {
    scheme: UPTO.scheme,
    network: terms.network,
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
      ...(terms.splits ? { splits: terms.splits } : {}),
      ...(hints ?? {}),
    },
  };
}
