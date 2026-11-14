// Holds buyer-wide authority while recovering existing child sessions; credit requires verified transfers.
import type { BatchPoolPaths } from '@gyblos/config/home';
import {
  PaymentSessionError,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';

import { batchOpeningAbsent } from './batch-opening-proof';
import { openPoolStore, poolChild, poolPaths } from './batch-pool-store';
import {
  recoverBatchBuyer,
  type BatchRecoveryOptions,
  type BatchRecoveryResult,
} from './batch-recovery';
import { WITHDRAW_STEPS } from './constants';

export async function recoverBatchPool(
  options: Omit<BatchRecoveryOptions, 'paths'> & { paths: BatchPoolPaths },
): Promise<BatchRecoveryResult[]> {
  const store = await openPoolStore(options.paths, options.now ?? Date.now);
  const results: BatchRecoveryResult[] = [];
  try {
    for (const row of store.read().entries) {
      let channelId = '';
      try {
        options.signal?.throwIfAborted();
        const child = await poolChild(options.paths, row);
        channelId = child.channelId;
        const result = await recoverBatchBuyer({
          ...options,
          paths: poolPaths(options.paths, row),
        });
        if (!result) return sessionFail(SESSION_CODES.UNVERIFIED);
        if (result.settlement || result.notCreated) {
          const verified = await poolChild(options.paths, row);
          if (
            result.notCreated
              ? !batchOpeningAbsent(verified)
              : verified.state !== SESSION_STATES.CLOSED ||
                verified.settlement?.transaction !==
                  result.settlement!.transaction
          )
            return sessionFail(SESSION_CODES.UNVERIFIED);
          await store.update((state) => {
            const next = state.entries.find(
              (entry) => entry.terms.sellerNodeId === row.terms.sellerNodeId,
            );
            if (!next) return sessionFail(SESSION_CODES.BINDING);
            if (result.settlement)
              next.refundedAtomic = result.settlement.refundedAtomic;
            next.requestId = null;
            next.uncertain = false;
          });
        }
        results.push(result);
      } catch (error) {
        results.push({
          channelId,
          step: WITHDRAW_STEPS.FAILED,
          transaction: null,
          confirmed: false,
          retryAfterSeconds: null,
          settlement: null,
          failure:
            error instanceof PaymentSessionError
              ? error.code
              : SESSION_CODES.UNAVAILABLE,
        });
      }
    }
    return results;
  } finally {
    await store.dispose();
  }
}
