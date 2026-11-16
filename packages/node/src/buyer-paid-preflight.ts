// Shares pure per-order validation across buyer hosts before delegated reservation or authorization.
// Input counting and wire parsing stay with their canonical core/protocol owners.
import { recountPaidInput } from '@gyblos/core/buyer-paid-recount';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import {
  paidExecutionFail,
  paidExecutionInput,
} from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { PaidBuyerError } from './buyer-paid-error';
import { PAID_BUYER_CODES } from './constants';

export function checkBuyerPaidInput(
  input: FreeExecutionBuildInput,
  meter: Parameters<typeof recountPaidInput>[1],
  quote: SignedOfferV2,
): string {
  const parsed = paidExecutionInput(quote, input);
  const counted = recountPaidInput(parsed, meter);
  if (!counted) throw new PaidBuyerError(PAID_BUYER_CODES.UNSUPPORTED);
  if (
    !Number.isSafeInteger(counted.inputTokens) ||
    counted.inputTokens < 0 ||
    counted.inputTokens + parsed.maxTokens > quote.offer.model.contextTokens
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
  return counted.prompt;
}
