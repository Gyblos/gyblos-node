// The free execution policy: every admission check (single use, concurrency, distinct buyers, daily and
// per-buyer token caps) without money. Finishing returns unused reserved tokens only for a completed
// recounted sale; a declared count never refunds on the provider's word.
import type { FreeExecutionAdmission } from '@gyblos/core/free-admission';
import type {
  ExecutionPermit,
  ExecutionPolicy,
} from '@gyblos/protocol/execution-policy';
import type { FreeExecutionRequest } from '@gyblos/protocol/free-execution';

import type { FreeMeter } from './free-meter';

export type FreeLease = ReturnType<FreeExecutionAdmission['enter']>;

export interface FreeAdmitContext {
  inputTokens: number;
  now: number;
}

export type FreePolicy = ExecutionPolicy<
  FreeExecutionRequest,
  FreeAdmitContext,
  FreeLease,
  undefined
>;

export function createFreePolicy(
  admission: FreeExecutionAdmission,
  meter: Pick<FreeMeter, 'refunds'>,
): FreePolicy {
  return {
    // Enters synchronously, so no other request interleaves; a refusal is a rejected promise.
    admit(request, context) {
      try {
        const permit: ExecutionPermit<FreeLease> = {
          outputTokens: request.input.maxTokens,
          state: admission.enter(request, context.inputTokens, context.now),
        };
        return Promise.resolve(permit);
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
    finish(permit, outcome) {
      permit.state.complete(
        outcome.completed && meter.refunds
          ? outcome.inputTokens + outcome.outputTokens
          : undefined,
      );
      return Promise.resolve(undefined);
    },
    release(permit) {
      // Idempotent: after finish this is a no-op; otherwise it frees the slot without a refund.
      permit.state.complete();
    },
  };
}
