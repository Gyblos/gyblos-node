// Static desktop explanations for validated buyer failures; remote text is never displayed.
// Presentation does not change retry decisions, budget reservations or payment uncertainty.
import {
  SELLER_SELECTION_CODES,
  type SellerSelectionCode,
} from '@gyblos/core/constants';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';

type BuyerCode = FreeExecutionCode | SellerSelectionCode;
export class DesktopBuyerFailure extends Error {
  constructor(
    readonly code: BuyerCode,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopBuyerFailure';
  }
}
function explanation(code: BuyerCode, reason: unknown, free: boolean) {
  if (code === SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET)
    return free
      ? 'No free seller is available right now. Wait or choose another model.'
      : 'No seller fits your price limits. Choose another model or review your budget.';
  if (
    code === SELLER_SELECTION_CODES.NO_CANDIDATES ||
    code === SELLER_SELECTION_CODES.PINNED_IN_COOLDOWN ||
    code === FREE_EXECUTION_CODES.BUSY
  )
    return 'The seller is not available right now. Wait or choose another model.';
  if (code === FREE_EXECUTION_CODES.LIMIT)
    return "The request or response exceeded this seller's limits. Shorten the message or choose another model.";
  if (
    code === FREE_EXECUTION_CODES.DAILY_CAP ||
    code === FREE_EXECUTION_CODES.BUYER_CAP
  )
    return 'The seller has reached its free allowance. Try another model or come back later.';
  if (
    code === FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE &&
    reason === FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED
  )
    return "The seller's model provider has reached its quota. Try another model or come back later.";
  if (
    code === FREE_EXECUTION_CODES.TIMEOUT ||
    (code === FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE &&
      reason === FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT)
  )
    return 'The seller did not finish in time. Shorten the message or choose another model.';
  if (
    code === FREE_EXECUTION_CODES.ENGINE ||
    code === FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE
  )
    return 'The seller could not continue the answer. Try another model or come back later.';
  if (code === FREE_EXECUTION_CODES.CANCELLED)
    return 'The answer was stopped. Any partial text is incomplete.';
  return 'The answer could not be verified. Check the seller connection before trying again.';
}
export function desktopBuyerFailure(
  value: unknown,
  policy: BuyerApiPolicy,
): Error {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const code = [
    ...Object.values(FREE_EXECUTION_CODES),
    ...Object.values(SELLER_SELECTION_CODES),
  ].find((code) => code === row.code);
  return code
    ? new DesktopBuyerFailure(
        code,
        explanation(code, row.reason, policy.maxAtomic === '0'),
      )
    : new Error('Buyer did not complete the request');
}
