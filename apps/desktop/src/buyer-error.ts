// Static desktop explanations for validated buyer failures; remote text is never displayed.
// Presentation does not change retry decisions, budget reservations or payment uncertainty.
import {
  BUYER_ROUTING_CODES,
  SELLER_SELECTION_CODES,
  type SellerSelectionCode,
} from '@gyblos/core/constants';
import {
  BUYER_API,
  BUYER_SIDECAR,
  type BuyerApiPolicy,
} from '@gyblos/protocol/buyer-api';
import {
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { CHAT_FAILURE } from './constants';

export class BuyerSessionRequired extends Error {
  constructor(
    reason:
      | typeof BUYER_SIDECAR.SESSION_REQUIRED
      | typeof BUYER_SIDECAR.DEPOSIT_MINIMUM = BUYER_SIDECAR.SESSION_REQUIRED,
  ) {
    super(
      reason === BUYER_SIDECAR.DEPOSIT_MINIMUM
        ? 'Select a paid seller and confirm its channel deposit to update the local buyer.'
        : 'Select a paid seller and set a maximum per response to enable its channel.',
    );
  }
}

type BuyerCode =
  | typeof CHAT_FAILURE.KEY_REVIEW
  | typeof BUYER_API.TOKENIZER_UNAVAILABLE
  | typeof BUYER_ROUTING_CODES.BUSY
  | typeof PAID_EXECUTION_CODES.EXPIRED
  | typeof PAID_EXECUTION_CODES.PEER
  | FreeExecutionCode
  | SellerSelectionCode
  | typeof SESSION_CODES.REQUEST_DECLINED
  | typeof SESSION_CODES.OPENING_ABSENT
  | typeof SESSION_CODES.OPENING_RETURNED
  | typeof SESSION_CODES.OPENING_PENDING
  | typeof SESSION_CODES.BINDING
  | typeof SESSION_CODES.UNVERIFIED
  | typeof SESSION_CODES.LIMIT;
export class DesktopBuyerFailure extends Error {
  constructor(
    readonly code: BuyerCode,
    message: string,
    readonly neverSent = false,
  ) {
    super(message);
    this.name = 'DesktopBuyerFailure';
  }
}
function explanation(code: BuyerCode, reason: unknown, free: boolean) {
  if (code === CHAT_FAILURE.KEY_REVIEW)
    return 'An API key reservation needs review. Desktop and connected tools are paused until its spending status is confirmed.';
  if (code === BUYER_ROUTING_CODES.BUSY)
    return 'The selected seller or channel is busy. If your buyer uses one channel, settle the existing channel before switching sellers.';
  if (code === SESSION_CODES.REQUEST_DECLINED)
    return 'The seller declined this request before charging you. You can send another message using this channel.';
  if (code === SESSION_CODES.OPENING_RETURNED)
    return 'The unused channel deposit was returned. You can send your message again.';
  if (code === SESSION_CODES.OPENING_PENDING)
    return 'The network has not confirmed the channel deposit yet. Wait a moment and try again with the same seller. Your message has not been sent.';
  if (code === SESSION_CODES.OPENING_ABSENT)
    return 'The deposit did not reach the chain. You can send your message again.';
  if (code === SESSION_CODES.BINDING)
    return 'The selected seller or terms changed. Refresh the listing before sending.';
  if (code === SESSION_CODES.UNVERIFIED)
    return 'The local buyer could not verify this seller. Review the listing and buyer settings.';
  if (code === SESSION_CODES.LIMIT)
    return 'Review the per-request maximum and channel deposit limits in the buyer profile before sending.';
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
  if (
    row.code === PAID_EXECUTION_CODES.EXPIRED &&
    row[BUYER_API.NEVER_SENT_FIELD] === true
  )
    return new DesktopBuyerFailure(
      PAID_EXECUTION_CODES.EXPIRED,
      'The seller quote expired before payment. Refresh the listing and send your message again.',
      true,
    );
  if (
    row.code === BUYER_API.TOKENIZER_UNAVAILABLE &&
    row[BUYER_API.NEVER_SENT_FIELD] === true
  )
    return new DesktopBuyerFailure(
      BUYER_API.TOKENIZER_UNAVAILABLE,
      'The app could not download or verify the files it needs to count tokens. Check your internet connection and try again. No payment was made.',
      true,
    );
  if (
    row.code === PAID_EXECUTION_CODES.PEER &&
    row[BUYER_API.NEVER_SENT_FIELD] === true
  )
    return new DesktopBuyerFailure(
      PAID_EXECUTION_CODES.PEER,
      'The selected seller could not open a payment channel. Choose another seller.',
      true,
    );
  const code = [
    CHAT_FAILURE.KEY_REVIEW,
    BUYER_ROUTING_CODES.BUSY,
    SESSION_CODES.REQUEST_DECLINED,
    SESSION_CODES.OPENING_ABSENT,
    SESSION_CODES.OPENING_RETURNED,
    SESSION_CODES.OPENING_PENDING,
    SESSION_CODES.BINDING,
    SESSION_CODES.UNVERIFIED,
    SESSION_CODES.LIMIT,
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
