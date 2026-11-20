// Parse free, settled and channel-approved responses from the authenticated buyer.
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { sessionApproval } from '@gyblos/node/session-accounting';
import {
  BUYER_API,
  buyerAtomic,
  type BuyerApiPolicy,
} from '@gyblos/protocol/buyer-api';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

import { reportedUsage } from './response-metrics';
import { DESKTOP_X402 } from './x402-model';

export function buyerResponseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid buyer response');
  return value as Record<string, unknown>;
}
export function parseBuyerReply(input: unknown, policy: BuyerApiPolicy) {
  const value = buyerResponseObject(input);
  if (
    value.model !== policy.model ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new Error('Invalid buyer response');
  const choice = buyerResponseObject(value.choices[0]);
  const message = buyerResponseObject(choice.message);
  if (
    message.role !== FREE_CHAT_ROLES.ASSISTANT ||
    typeof message.content !== 'string' ||
    message.content.length > DESKTOP_X402.MAX_RESPONSE ||
    (choice.finish_reason !== ENGINE_DONE_REASONS.STOP &&
      choice.finish_reason !== ENGINE_DONE_REASONS.LENGTH)
  )
    throw new Error('Incomplete buyer response');
  const payment = value[BUYER_API.PAYMENT_FIELD];
  const usage = reportedUsage(value.usage, policy.maxTokens);
  if (
    value[BUYER_API.EXECUTION_FIELD] === OFFER_PRICING_KINDS.FREE &&
    payment === undefined
  )
    return {
      text: message.content,
      chargeAtomic: '0',
      transaction: null,
      free: true,
      usage,
    };
  const paid = buyerResponseObject(payment);
  if (paid.verdict === SESSION_VERDICTS.APPROVED) {
    const approval = approvedSession(paid, policy, value);
    return {
      text: message.content,
      chargeAtomic: approval.approvedAtomic,
      transaction: null,
      free: false,
      usage,
      sessionApproval: approval,
    };
  }
  throw new Error(
    'Payment is not confirmed. Further messages are blocked until review.',
  );
}

function approvedSession(
  paid: Record<string, unknown>,
  policy: BuyerApiPolicy,
  value: Record<string, unknown>,
) {
  if (
    !paid.session ||
    paid.recorded !== true ||
    paid.chargedAtomic !== null ||
    paid.refundedAtomic !== null ||
    paid.feeAtomic !== null ||
    paid.sellerAtomic !== null ||
    paid.transaction !== undefined ||
    !buyerAtomic(paid.maxAtomic) ||
    BigInt(paid.maxAtomic) > BigInt(policy.maxAtomic) ||
    value[BUYER_API.EXECUTION_FIELD] !== OFFER_PRICING_KINDS.PAID
  )
    throw new Error('Payment is not confirmed.');
  const approval = sessionApproval(paid.session);
  if (
    approval.approvedAtomic !== paid.expectedAtomic ||
    BigInt(approval.approvedAtomic) > BigInt(paid.maxAtomic)
  )
    throw new Error('Invalid channel approval');
  return approval;
}
