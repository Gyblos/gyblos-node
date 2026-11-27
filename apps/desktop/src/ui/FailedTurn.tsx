import { useState } from 'react';

import { channelBlockerMessage } from '@gyblos/node/buyer-channel-message';
import { isChannelBlocker } from '@gyblos/protocol/buyer-api';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { CHAT_FAILURE } from '../constants';
import { paypalPromptCorrection } from '../paypal-chat-notice';
import { PAYMENT_METHOD } from '../paypal-model';
import { X402_ACTION } from '../x402-model';
import type { ChatMessage } from './chat-state';
import { BUTTON_VARIANT } from './constants';
import { Notice } from './Notice';
import { Button } from './UI';
import { keyReviewStatus } from './useUsdcApiKeys';
import type { X402View } from './useX402';

function beforeSending(reason: ChatMessage['failureReason']) {
  switch (reason) {
    case CHAT_FAILURE.QUOTE_EXPIRED:
      return 'The seller quote expired before the buyer sent this question.';
    case CHAT_FAILURE.TOKENIZER_UNAVAILABLE:
      return 'The buyer could not prepare the token counter before sending this question.';
    case CHAT_FAILURE.PEER:
      return 'The buyer could not open a channel with this seller before sending this question.';
    case CHAT_FAILURE.STALE_OFFER:
      return 'Refresh the model list to verify the seller and its current price before sending.';
    case CHAT_FAILURE.PAYPAL_PROMPT_INVALID:
      return paypalPromptCorrection;
    case CHAT_FAILURE.PAYPAL_PROMPT_TOO_LONG:
      return 'Shorten the question to fit the PayPal message limit.';
    case CHAT_FAILURE.NOT_SENT:
      return 'The buyer stopped this question before sending it.';
  }
}

function failureExplanation(
  message: ChatMessage,
  free: boolean,
  stopped: string | undefined,
) {
  if (stopped) return stopped + ' No charge was made for this turn.';
  switch (message.failureReason) {
    case CHAT_FAILURE.FREE_LIMIT:
      return (
        (message.text
          ? 'This response is incomplete because the stream reached an output limit. Ask for a shorter answer or choose a model with a higher limit.'
          : 'Shorten the question or choose a model with a higher limit.') +
        (free ? '' : ' The final charge is unknown.')
      );
    case CHAT_FAILURE.KEY_REVIEW_NOT_SENT:
      return 'An API key spending review paused Desktop and connected tools before this question was sent. No charge was made for this turn.';
    case CHAT_FAILURE.KEY_REVIEW:
      return 'An API key spending review paused Desktop and connected tools for this request. The final charge is unknown.';
    case CHAT_FAILURE.DECLINED:
      return 'The seller declined this question before charging you.';
    default:
      return free
        ? 'The free response was interrupted. Any text shown is incomplete.'
        : `The ${message.paymentMethod === PAYMENT_METHOD.PAYPAL ? 'PayPal' : 'USDC'} response was interrupted. The final charge is unknown.`;
  }
}

function useRecoveryStatus(shared: boolean, buyer?: X402View) {
  const [observation, setObservation] = useState('');
  const [checking, setChecking] = useState(false);
  async function checkStatus() {
    if (shared) {
      setChecking(true);
      setObservation(await keyReviewStatus(buyer?.state.policy?.policyId));
      setChecking(false);
      return;
    }
    const status = await buyer?.run({ action: X402_ACTION.REVIEW });
    const budgetStatus =
      status?.error || !status?.summary.available
        ? 'The status check was unavailable.'
        : status.summary.blocked
          ? 'The desktop budget still has spending under review.'
          : 'The desktop budget reports no pending review.';
    setObservation(
      budgetStatus + ' The charge for this turn remains unconfirmed.',
    );
  }
  return { observation, checking, checkStatus };
}

export function FailedTurn({
  message,
  buyer,
  separateDraft,
  onReview,
  onConnections,
  onSellers,
  onEdit,
}: {
  message: ChatMessage;
  buyer?: X402View;
  separateDraft: boolean;
  onReview?: () => void;
  onConnections: () => void;
  onSellers: () => void;
  onEdit: () => void;
}) {
  const reason = message.failureReason;
  const declined = reason === CHAT_FAILURE.DECLINED;
  const shared =
    reason === CHAT_FAILURE.KEY_REVIEW_NOT_SENT ||
    reason === CHAT_FAILURE.KEY_REVIEW;
  const { observation, checking, checkStatus } = useRecoveryStatus(
    shared,
    buyer,
  );
  const free =
    message.model.free && message.paymentMethod === PAYMENT_METHOD.USDC;
  const sameSession =
    message.paymentMethod === PAYMENT_METHOD.USDC &&
    !!message.paymentSessionId &&
    message.paymentSessionId === buyer?.state.summary.sessionId;
  const channel =
    isChannelBlocker(reason) && reason !== CHAT_FAILURE.KEY_REVIEW
      ? reason
      : undefined;
  const seller =
    channel === SESSION_CODES.BINDING ||
    channel === SESSION_CODES.REPLACEMENT_REQUIRED;
  const stopped = channel
    ? channelBlockerMessage(channel)
    : beforeSending(reason);
  return (
    <>
      <Notice>
        {failureExplanation(message, free, stopped)}
        {observation && ' ' + observation}
      </Notice>
      <div className="answer-actions">
        {channel ? (
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            onClick={seller ? onSellers : onReview}
          >
            {seller ? 'Review sellers' : 'Review in Payments'}
          </Button>
        ) : declined || stopped || (free && !shared) ? (
          <Button variant={BUTTON_VARIANT.SECONDARY} onClick={onEdit}>
            {separateDraft ? 'Edit in new chat' : 'Edit question'}
          </Button>
        ) : sameSession ? (
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            disabled={buyer?.busy || checking}
            onClick={() => void checkStatus()}
          >
            Check status
          </Button>
        ) : (
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            onClick={shared ? onConnections : onReview}
          >
            {shared ? 'Review in Connections' : 'Review in Payments'}
          </Button>
        )}
      </div>
    </>
  );
}
