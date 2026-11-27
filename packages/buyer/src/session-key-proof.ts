import {
  batchPoolChannelPaths,
  batchPoolPathsIn,
} from '@gyblos/config/home-payments';
import type { ConfirmKeyCharge } from '@gyblos/node/buyer-api-keys';
import { reviewPayment } from '@gyblos/node/buyer-payment-review';
import {
  batchSessionObserver,
  finalizedKeyCharge,
  inspectBatchPool,
} from '@gyblos/payments-upto/batch-session';

import type { BuyerExecutionFactory } from './free-startup';
import type { BuyerStartupOptions } from './session-requirements';

export function keyProof(
  context: Parameters<BuyerExecutionFactory>[0],
  options: BuyerStartupOptions,
): ConfirmKeyCharge {
  return async (ref, scope, deadline) => {
    const pool = batchPoolPathsIn(process.env);
    const entries = await inspectBatchPool(pool, { includeLegacy: false });
    const slot = entries.find(
      (entry) => entry.terms.sellerNodeId === ref.sellerNodeId,
    );
    if (entries.length && !slot) return undefined;
    const paths =
      slot && !slot.legacy
        ? batchPoolChannelPaths(pool, ref.sellerNodeId)
        : pool.legacy;
    return reviewPayment(
      (signal) =>
        finalizedKeyCharge(
          paths,
          ref,
          scope,
          context.endpoint.id().toString(),
          (terms, channelId) =>
            options.observeSettlement
              ? options.observeSettlement(channelId)
              : batchSessionObserver({
                  paths,
                  terms,
                  rpcUrl: context.role.rpcUrl,
                }).settlement(channelId, signal),
        ),
      deadline,
    );
  };
}
