// Composes the pinned batch SDK with durable pending operations and a reconstructed receiver binding.
// No rent-cleanup worker or network process starts here; the host supplies its chain signer.
import type { FacilitatorSvmSigner } from '@x402/svm';
import {
  BatchSvmScheme,
  InMemoryBatchChannelStorage,
} from '@x402/svm/batch-settlement/facilitator';

import { UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { paymentSplits } from '@gyblos/protocol/payment-binding';
import type { PaymentSessionTerms } from '@gyblos/protocol/payment-session';

import { requirementsFor } from './batch-session-checks';
import type { BatchSellerOptions } from './batch-session-types';

export function batchFacilitatorFor(
  signer: FacilitatorSvmSigner,
  terms: PaymentSessionTerms,
): BatchSellerOptions['facilitator'] {
  return async (pending, channel) => {
    const requirements = await requirementsFor(terms);
    const channelStorage = new InMemoryBatchChannelStorage();
    if (channel)
      await channelStorage.recordOpen({
        network: requirements.network,
        channelId: channel.channelId,
        payTo: terms.payTo,
        tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
        expiresAt: 0,
        lastActivityAt: 0,
        receiverAuthorizer: terms.authorizer,
        callerIdentity: '',
        splits: paymentSplits(terms),
      });
    return new BatchSvmScheme(signer, {
      pendingSettlementStore: pending,
      channelStorage,
      maxIdleSecs: 0,
    });
  };
}
