// Shared, public-only desktop sandbox messages; never carries credentials or payment identifiers.
import type { MessageBoxOptions } from 'electron';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';
import { isPaypalId } from '@gyblos/protocol/paypal-payment';

import { activityId } from './activity-model';
import {
  PAYMENT_METHOD,
  PAYPAL_ACTION,
  PAYPAL_DESKTOP_ERROR,
} from './constants';
import type { DesktopPaypalStatus } from './paypal-session';

export {
  PAYMENT_METHOD,
  PAYPAL_ACTION,
  PAYPAL_DESKTOP_ERROR,
} from './constants';

const PAYPAL_RENDER_LIMITS = {
  modelCharacters: 128,
  responseCharacters: 1_000_000,
} as const;
export function paypalDollars(cents: number) {
  return `USD ${(cents / PAYPAL_SANDBOX.centsPerDollar).toFixed(2)}`;
}

export function paypalUsageSummary(spentCents: number, limitCents: number) {
  return `${paypalDollars(spentCents)} used of ${paypalDollars(limitCents)}`;
}

export type PaymentMethod =
  (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export function paymentMethodLabel(method: PaymentMethod) {
  return method === PAYMENT_METHOD.PAYPAL ? 'PayPal Sandbox' : 'USDC preview';
}

export function canSelectPreviewModel(method: PaymentMethod) {
  return method === PAYMENT_METHOD.USDC;
}

export function canSwitchPaymentMethod(
  current: PaymentMethod,
  next: PaymentMethod,
  paypalBusy: boolean,
  responseBusy = false,
) {
  return (
    current === next ||
    (!responseBusy && !(current === PAYMENT_METHOD.PAYPAL && paypalBusy))
  );
}

// A USDC-only view must not start the PayPal service or reuse a stale status.
export function shouldMonitorPaypal(
  method: PaymentMethod,
  showingDetails: boolean,
) {
  return method === PAYMENT_METHOD.PAYPAL && showingDetails;
}

export function paypalStatusVisible(method: PaymentMethod, fresh: boolean) {
  return method === PAYMENT_METHOD.PAYPAL && fresh;
}

export function paypalHasUnfinishedSession(
  status: Pick<DesktopPaypalStatus, 'phase'> | null,
) {
  return (
    status !== null &&
    status.phase !== PAYPAL_SESSION_STATUS.READY &&
    status.phase !== PAYPAL_SESSION_PHASE.COMPLETED &&
    status.phase !== PAYPAL_SESSION_PHASE.VOIDED &&
    status.phase !== PAYPAL_SESSION_PHASE.CANCELLED
  );
}

export function paypalAmountsAvailable(
  status: Pick<DesktopPaypalStatus, 'phase'> | null,
) {
  return (
    status !== null &&
    status.phase !== PAYPAL_SESSION_STATUS.READY &&
    status.phase !== PAYPAL_SESSION_STATUS.BLOCKED
  );
}

// Amounts are current only after a successful check and outside an operation.
export function paypalPaymentSummary(
  status: Pick<
    DesktopPaypalStatus,
    | 'phase'
    | 'expired'
    | 'remainingAttempts'
    | 'spentCents'
    | 'limitCents'
    | 'messageCents'
  > | null,
  fresh: boolean,
  busy: boolean,
) {
  const current = fresh && !busy ? status : null;
  const hasAmounts = current !== null && paypalAmountsAvailable(current);
  const available =
    current?.phase === PAYPAL_SESSION_PHASE.ACTIVE &&
    !current.expired &&
    current.remainingAttempts > 0;
  return {
    label: busy ? 'Updating session…' : paypalActivityLabel(current),
    usedCents: hasAmounts ? current.spentCents : null,
    limitCents: hasAmounts ? current.limitCents : null,
    remainingCents:
      hasAmounts && available
        ? Math.max(0, current.limitCents - current.spentCents)
        : null,
    capturedCents:
      current?.phase === PAYPAL_SESSION_PHASE.COMPLETED
        ? current.spentCents
        : null,
    rateCents: hasAmounts ? current.messageCents : null,
  };
}

export function paypalNewSessionTerms(
  status: Pick<
    DesktopPaypalStatus,
    'phase' | 'limitCents' | 'messageCents'
  > | null,
  fresh: boolean,
) {
  if (
    !fresh ||
    !status ||
    ![
      PAYPAL_SESSION_STATUS.READY,
      PAYPAL_SESSION_PHASE.COMPLETED,
      PAYPAL_SESSION_PHASE.VOIDED,
      PAYPAL_SESSION_PHASE.CANCELLED,
    ].some((phase) => phase === status.phase)
  )
    return null;
  return {
    limitCents: PAYPAL_SANDBOX.limitCents,
    messageCents: PAYPAL_SANDBOX.messageCents,
  };
}

export function paypalSessionCanConnectAgent(
  status: Pick<
    DesktopPaypalStatus,
    'phase' | 'expired' | 'remainingAttempts' | 'spentCents' | 'limitCents'
  > | null,
  fresh: boolean,
  busy: boolean,
) {
  return (
    fresh &&
    !busy &&
    status !== null &&
    status.phase === PAYPAL_SESSION_PHASE.ACTIVE &&
    !status.expired &&
    status.remainingAttempts > 0 &&
    status.spentCents < status.limitCents
  );
}

export function paypalActivityLabel(
  status: Pick<DesktopPaypalStatus, 'phase' | 'expired'> | null,
) {
  if (!status) return 'Status unavailable';
  switch (status.phase) {
    case PAYPAL_SESSION_STATUS.READY:
      return 'No session';
    case PAYPAL_SESSION_PHASE.CREATED:
      return 'Approval not confirmed';
    case PAYPAL_SESSION_PHASE.CREATING:
    case PAYPAL_SESSION_PHASE.AUTHORIZING:
      return 'Preparing or needs review';
    case PAYPAL_SESSION_PHASE.ACTIVE:
      return status.expired ? 'Session expired' : 'Session active';
    case PAYPAL_SESSION_PHASE.COMPLETED:
      return 'Payment captured';
    case PAYPAL_SESSION_PHASE.VOIDED:
      return 'Authorization voided';
    case PAYPAL_SESSION_PHASE.CANCELLED:
      return 'Checkout abandoned locally';
    case PAYPAL_SESSION_PHASE.EXECUTING:
      return 'Inference running or needs review';
    case PAYPAL_SESSION_PHASE.MESSAGE_PENDING:
      return 'Response awaiting confirmation';
    case PAYPAL_SESSION_PHASE.CAPTURING:
      return 'Payment closure needs review';
    case PAYPAL_SESSION_PHASE.VOIDING:
      return 'Authorization closure needs review';
    default:
      return 'Needs review';
  }
}
export const DESKTOP_PAYPAL = {
  CHANNEL: 'desktop:paypal',
  RETURN_CHANNEL: 'desktop:paypal-return',
  CANCEL_CHANNEL: 'desktop:paypal-cancel',
  REVIEW_ID_CHARACTERS: 12,
} as const;
export function paypalReviewDialog(ticket: {
  fingerprint: string;
  spentCents: number;
}): MessageBoxOptions {
  const amount = paypalDollars(ticket.spentCents);
  return {
    type: 'warning',
    message: 'Review PayPal Sandbox session',
    detail: `This uses test funds. The last inference has an unknown outcome. If authorized to act for both buyer and seller, you may waive that attempt and capture ${amount} for previously recorded usage. Confirm that no other PayPal operation is in progress. Gyblos will check PayPal before closing. Review ID: ${ticket.fingerprint.slice(0, DESKTOP_PAYPAL.REVIEW_ID_CHARACTERS)}.`,
    buttons: ['Keep under review', `Waive and capture ${amount}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function paypalFinishDialog(summary: {
  spentCents: number;
  limitCents: number;
}): MessageBoxOptions {
  const amount = paypalDollars(summary.spentCents);
  const limit = paypalDollars(summary.limitCents);
  const used = summary.spentCents > 0;
  return {
    type: 'question',
    message: 'Review PayPal Sandbox session',
    detail: used
      ? `Test funds only. Authorized maximum: ${limit}. Recorded usage: ${amount}. Confirming will attempt to capture ${amount}. PayPal controls release of the remaining authorization.`
      : `Test funds only. Authorized maximum: ${limit}. No usage was recorded. Confirming will attempt to void the unused authorization.`,
    buttons: [
      'Keep session open',
      used ? `Capture ${amount}` : 'Void authorization',
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export type PaypalRequest =
  | {
      action:
        | typeof PAYPAL_ACTION.STATUS
        | typeof PAYPAL_ACTION.OPEN
        | typeof PAYPAL_ACTION.APPROVE
        | typeof PAYPAL_ACTION.COMPLETE_RETURN
        | typeof PAYPAL_ACTION.COMPLETE_CANCEL
        | typeof PAYPAL_ACTION.FINISH
        | typeof PAYPAL_ACTION.CHECK_VOID
        | typeof PAYPAL_ACTION.REVIEW_AND_SETTLE
        | typeof PAYPAL_ACTION.ABANDON;
    }
  | { action: typeof PAYPAL_ACTION.CREATE; limitCents?: number }
  | { action: typeof PAYPAL_ACTION.SEND; prompt: string }
  | { action: typeof PAYPAL_ACTION.ACKNOWLEDGE; messageId: string };
export type PaypalResult = {
  sessionId?: string;
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
      'approvalLinkAvailable,expired,limitCents,messageCents,phase,remainingAttempts,spentCents'
  )
    return null;
  const phase = [
    ...Object.values(PAYPAL_SESSION_PHASE),
    ...Object.values(PAYPAL_SESSION_STATUS),
  ].find((entry) => entry === item.phase);
  if (
    !phase ||
    typeof item.approvalLinkAvailable !== 'boolean' ||
    (item.approvalLinkAvailable && phase !== PAYPAL_SESSION_PHASE.CREATED) ||
    typeof item.expired !== 'boolean' ||
    typeof item.spentCents !== 'number' ||
    !Number.isSafeInteger(item.spentCents) ||
    item.spentCents < 0 ||
    typeof item.limitCents !== 'number' ||
    !Number.isSafeInteger(item.limitCents) ||
    item.limitCents < 1 ||
    item.limitCents < item.spentCents ||
    typeof item.messageCents !== 'number' ||
    !Number.isSafeInteger(item.messageCents) ||
    item.messageCents < 1 ||
    item.messageCents > item.limitCents ||
    typeof item.remainingAttempts !== 'number' ||
    !Number.isSafeInteger(item.remainingAttempts) ||
    item.remainingAttempts < 0
  )
    return null;
  return {
    approvalLinkAvailable: item.approvalLinkAvailable,
    phase,
    expired: item.expired,
    spentCents: item.spentCents,
    limitCents: item.limitCents,
    messageCents: item.messageCents,
    remainingAttempts: item.remainingAttempts,
  };
}
export function parsePaypalResult(value: unknown): PaypalResult {
  const item = record(value);
  if (
    !item ||
    ![
      'answer,error,model,status',
      'answer,error,model,sessionId,status',
    ].includes(Object.keys(item).sort().join(','))
  )
    return paypalFailure();
  if (
    'sessionId' in item &&
    (!activityId(item.sessionId) || item.status === null)
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
  return {
    error,
    status,
    model,
    answer,
    ...(activityId(item.sessionId) ? { sessionId: item.sessionId } : {}),
  };
}

// Coordinates navigation only; approval and settlement remain separate guarded actions.
export function managePaypal(
  select: (method: typeof PAYMENT_METHOD.PAYPAL) => boolean,
  open: () => void,
) {
  if (!select(PAYMENT_METHOD.PAYPAL)) return false;
  open();
  return true;
}
