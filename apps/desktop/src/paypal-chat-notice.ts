// Formats public sandbox chat errors without exposing payment identifiers.
import { PAYPAL_DESKTOP_ERROR, type PaypalResult } from './paypal-model';

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
