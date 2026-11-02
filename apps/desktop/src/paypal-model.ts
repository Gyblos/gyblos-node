// Shared, public-only desktop sandbox messages; never carries credentials or payment identifiers.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';
import { isPaypalId } from '@gyblos/protocol/paypal-payment';

import type { DesktopPaypalStatus } from './paypal-session';

const PAYPAL_RENDER_LIMITS = {
  modelCharacters: 128,
  responseCharacters: 1_000_000,
} as const;

export const PAYMENT_METHOD = {
  USDC: 'usdc',
  PAYPAL: 'paypal-sandbox',
} as const;
export type PaymentMethod =
  (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];
export const DESKTOP_PAYPAL = { CHANNEL: 'desktop:paypal' } as const;
export const PAYPAL_ACTION = {
  STATUS: 'status',
  CREATE: 'create',
  OPEN: 'open',
  APPROVE: 'approve',
  SEND: 'send',
  ACKNOWLEDGE: 'acknowledge',
  FINISH: 'finish',
  ABANDON: 'abandon',
} as const;
export const PAYPAL_DESKTOP_ERROR = {
  DENIED: 'denied',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  NOT_APPROVED: 'not-approved',
  FAILED: 'failed',
} as const;

export type PaypalRequest =
  | {
      action:
        | typeof PAYPAL_ACTION.STATUS
        | typeof PAYPAL_ACTION.CREATE
        | typeof PAYPAL_ACTION.OPEN
        | typeof PAYPAL_ACTION.APPROVE
        | typeof PAYPAL_ACTION.FINISH
        | typeof PAYPAL_ACTION.ABANDON;
    }
  | { action: typeof PAYPAL_ACTION.SEND; prompt: string }
  | { action: typeof PAYPAL_ACTION.ACKNOWLEDGE; messageId: string };
export type PaypalResult = {
  status: DesktopPaypalStatus | null;
  model: string | null;
  answer: { text: string; messageId: string } | null;
  error:
    (typeof PAYPAL_DESKTOP_ERROR)[keyof typeof PAYPAL_DESKTOP_ERROR] | null;
};

export function paypalFailure(
  error: PaypalResult['error'] = PAYPAL_DESKTOP_ERROR.FAILED,
): PaypalResult {
  return { status: null, model: null, answer: null, error };
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function parseStatus(value: unknown): DesktopPaypalStatus | null {
  const item = record(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !==
      'expired,limitCents,messageCents,phase,remainingAttempts,spentCents'
  )
    return null;
  const phase = [
    ...Object.values(PAYPAL_SESSION_PHASE),
    ...Object.values(PAYPAL_SESSION_STATUS),
  ].find((entry) => entry === item.phase);
  if (
    !phase ||
    typeof item.expired !== 'boolean' ||
    typeof item.spentCents !== 'number' ||
    !Number.isSafeInteger(item.spentCents) ||
    item.spentCents < 0 ||
    item.limitCents !== PAYPAL_SANDBOX.limitCents ||
    item.limitCents < item.spentCents ||
    item.messageCents !== PAYPAL_SANDBOX.messageCents ||
    typeof item.remainingAttempts !== 'number' ||
    !Number.isSafeInteger(item.remainingAttempts) ||
    item.remainingAttempts < 0
  )
    return null;
  return {
    phase,
    expired: item.expired,
    spentCents: item.spentCents,
    limitCents: PAYPAL_SANDBOX.limitCents,
    messageCents: PAYPAL_SANDBOX.messageCents,
    remainingAttempts: item.remainingAttempts,
  };
}
export function parsePaypalResult(value: unknown): PaypalResult {
  const item = record(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !== 'answer,error,model,status'
  )
    return paypalFailure();
  const error =
    item.error === null
      ? null
      : Object.values(PAYPAL_DESKTOP_ERROR).find(
          (entry) => entry === item.error,
        );
  if (error === undefined) return paypalFailure();
  const status = item.status === null ? null : parseStatus(item.status);
  if (item.status !== null && !status) return paypalFailure();
  const model = item.model;
  if (
    model !== null &&
    (typeof model !== 'string' ||
      model.length === 0 ||
      model.length > PAYPAL_RENDER_LIMITS.modelCharacters)
  )
    return paypalFailure();
  const valueAnswer = item.answer === null ? null : record(item.answer);
  if (
    item.answer !== null &&
    (!valueAnswer ||
      Object.keys(valueAnswer).sort().join(',') !== 'messageId,text' ||
      typeof valueAnswer.text !== 'string' ||
      valueAnswer.text.length > PAYPAL_RENDER_LIMITS.responseCharacters ||
      !isPaypalId(valueAnswer.messageId))
  )
    return paypalFailure();
  const answer =
    valueAnswer &&
    typeof valueAnswer.text === 'string' &&
    isPaypalId(valueAnswer.messageId)
      ? { text: valueAnswer.text, messageId: valueAnswer.messageId }
      : null;
  return { error, status, model, answer };
}
