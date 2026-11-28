// Maps the authenticated buyer's channel failures without exposing credentials or remote errors.
import { HTTP_STATUS } from '@gyblos/config';
import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import {
  DeclinedChannelRequest,
  UnsentChannelPeerError,
  UnsentOpeningError,
} from '@gyblos/node/batch-buyer';
import { channelBlockerMessage } from '@gyblos/node/buyer-channel-message';
import { bounded } from '@gyblos/node/buyer-operation';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import {
  UnsentChannelRequestError,
  UnsentSellerChoiceError,
} from '@gyblos/node/buyer-session';
import { UnsentChannelLimitError } from '@gyblos/node/session-policy';
import { BatchChannelError } from '@gyblos/protocol/batch-channel';
import { isChannelBlocker } from '@gyblos/protocol/buyer-api';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import { PaymentSessionError } from '@gyblos/protocol/payment-session';

import { buyerApiKeyErrorView } from './api-key-http';
import { freeErrorView } from './chat-errors';
import { FREE_BUYER_CODES, PAID_BUYER_CODES } from './constants';
import { AfterFreeDispatch } from './free-chat-error';
import type { ChatErrorView } from './free-http';

const unavailable = (
  code: ChatErrorView['code'],
  neverSent: boolean,
): ChatErrorView => ({
  code,
  status:
    code === PAID_EXECUTION_CODES.TIMEOUT
      ? HTTP_STATUS.gatewayTimeout
      : HTTP_STATUS.serviceUnavailable,
  neverSent,
  stop: {},
});

class UnsentSessionPreflightError extends BatchChannelError {}

export function unaffordableSessionQuote(
  error: unknown,
): error is BatchChannelError {
  return (
    error instanceof UnsentSessionPreflightError &&
    error.code === PAID_EXECUTION_CODES.BUDGET_EXHAUSTED
  );
}

// Applies only around local recounting and quote verification, before opening a channel or sending input.
export async function unsentSessionPreflight<T>(
  operation: Promise<T>,
  signal: AbortSignal,
) {
  try {
    return await bounded(operation, signal);
  } catch (error) {
    if (
      error instanceof PaymentSessionError ||
      (error instanceof BatchChannelError && !error.remote)
    )
      throw new UnsentSessionPreflightError(error.code);
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new UnsentSessionPreflightError(PAID_EXECUTION_CODES.TIMEOUT);
    throw error;
  }
}

// Paid errors only; anything else is left to the free answer.
export function classifyPaidError(error: unknown): ChatErrorView | undefined {
  if (error instanceof AfterFreeDispatch) {
    const view =
      classifyPaidError(error.subsequent) ?? freeErrorView(error.subsequent);
    return {
      ...view,
      neverSent: false,
      status:
        view.status === HTTP_STATUS.tooManyRequests
          ? HTTP_STATUS.serviceUnavailable
          : view.status,
    };
  }
  if (error instanceof UnsentSellerChoiceError && isChannelBlocker(error.code))
    return {
      ...unavailable(error.code, true),
      status: HTTP_STATUS.badRequest,
      detail: channelBlockerMessage(error.code),
    };
  if (
    error instanceof UnsentOpeningError ||
    error instanceof UnsentSessionPreflightError ||
    error instanceof UnsentSellerChoiceError ||
    error instanceof UnsentChannelRequestError ||
    error instanceof UnsentChannelLimitError ||
    error instanceof UnsentChannelPeerError
  )
    return unavailable(error.code, true);
  if (error instanceof DeclinedChannelRequest)
    return unavailable(error.code, false);
  const keyError = buyerApiKeyErrorView(error);
  if (keyError) return keyError;
  if (
    error instanceof BuyerRoutingError ||
    error instanceof UnsentSellerBusyError
  )
    return {
      ...unavailable(error.code, true),
      status:
        error.code === BUYER_ROUTING_CODES.BUSY
          ? HTTP_STATUS.tooManyRequests
          : error.code === BUYER_ROUTING_CODES.QUEUE_TIMEOUT
            ? HTTP_STATUS.gatewayTimeout
            : HTTP_STATUS.badRequest,
    };
  if (
    error instanceof PaymentSessionError ||
    error instanceof BatchChannelError
  )
    return unavailable(error.code, false);
  if (error instanceof PaidBuyerError) {
    if (error.code === PAID_BUYER_CODES.UNSUPPORTED)
      return {
        ...unavailable(error.code, true),
        status: HTTP_STATUS.badRequest,
      };
    if (error.code === PAID_BUYER_CODES.BUSY)
      return {
        ...unavailable(error.code, true),
        status: HTTP_STATUS.tooManyRequests,
      };
    return unavailable(error.code, true);
  }
  // Payment errors come from authorizing or reading the journal, before anything is sent.
  if (error instanceof PaymentError) return unavailable(error.code, true);
  // The paid request's own deadline; an open may have been sent by then.
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return {
      ...unavailable(FREE_BUYER_CODES.TIMEOUT, false),
      status: HTTP_STATUS.gatewayTimeout,
    };
  return undefined;
}
