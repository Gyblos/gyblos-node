// Formats public sandbox chat errors without exposing payment identifiers.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

import {
  PAYPAL_ACTION,
  PAYPAL_DESKTOP_ERROR,
  type PaypalRequest,
  type PaypalResult,
} from './paypal-model';
import type { DesktopPaypalStatus } from './paypal-session';

export function paypalCommandNotice(
  request: PaypalRequest,
  result: PaypalResult,
  previous: DesktopPaypalStatus | null,
  pendingMessageId: string | null,
  currentNotice: string,
) {
  if (request.action === PAYPAL_ACTION.CHECK_VOID) {
    return !result.error &&
      result.status?.phase === PAYPAL_SESSION_PHASE.VOIDING
      ? 'PayPal confirms the authorization is voided. Payment history was not verified; the session remains under review.'
      : 'PayPal could not confirm the authorization. The session remains under review.';
  }
  if (result.error) return paypalChatFailure(result);
  if (
    request.action === PAYPAL_ACTION.FINISH &&
    result.status?.phase === PAYPAL_SESSION_PHASE.ACTIVE
  )
    return 'Session remains open. No payment was requested.';
  if (
    result.status?.phase === PAYPAL_SESSION_PHASE.MESSAGE_PENDING &&
    !pendingMessageId
  )
    return 'A prior response awaits confirmation. Review the session.';
  return request.action === PAYPAL_ACTION.STATUS &&
    result.status?.phase === previous?.phase
    ? currentNotice
    : '';
}

export function paypalChatFailure(result: PaypalResult) {
  if (
    result.error === PAYPAL_DESKTOP_ERROR.INVALID_PROMPT &&
    result.status?.expired
  )
    return 'The sandbox session has expired. Close it to settle recorded usage.';
  if (
    result.error === PAYPAL_DESKTOP_ERROR.INVALID_PROMPT &&
    result.status &&
    (result.status.remainingAttempts === 0 ||
      result.status.spentCents + result.status.messageCents >
        result.status.limitCents)
  )
    return 'The sandbox session limit has been reached. Close it to settle recorded usage.';
  if (result.error === PAYPAL_DESKTOP_ERROR.INVALID_PROMPT)
    return 'Shorten the message or remove reserved model control markers, then try again.';
  if (result.error === PAYPAL_DESKTOP_ERROR.NOT_APPROVED)
    return result.status?.approvalLinkAvailable
      ? 'Approve the request in PayPal Sandbox before starting the session.'
      : 'PayPal has not confirmed approval. If already approved, check again; otherwise abandon this order and start a new session.';
  if (result.error === PAYPAL_DESKTOP_ERROR.INTERRUPTED)
    return 'The approval check was interrupted before authorization.';
  if (result.error === PAYPAL_DESKTOP_ERROR.UNAVAILABLE)
    return 'PayPal Sandbox is unavailable. Check its configuration and the local model.';
  return 'The operation could not be confirmed. Check the session before continuing.';
}
