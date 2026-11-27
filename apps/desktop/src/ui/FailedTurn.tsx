import { useState } from 'react';

import { CHAT_FAILURE } from '../constants';
import { PAYMENT_METHOD } from '../paypal-model';
import { X402_ACTION } from '../x402-model';
import type { ChatMessage } from './chat-state';
import { BUTTON_VARIANT } from './constants';
import { MessageText } from './MessageText';
import { Notice } from './Notice';
import { Button } from './UI';
import type { X402View } from './useX402';

export function FailedTurn({
  message,
  buyer,
  separateDraft,
  onReview,
  onEdit,
}: {
  message: ChatMessage;
  buyer?: X402View;
  separateDraft: boolean;
  onReview?: () => void;
  onEdit: () => void;
}) {
  const [observation, setObservation] = useState('');
  const declined = message.failureReason === CHAT_FAILURE.DECLINED;
  const shared = message.failureReason === CHAT_FAILURE.KEY_REVIEW;
  const free =
    message.model.free && message.paymentMethod === PAYMENT_METHOD.USDC;
  const sameSession =
    message.paymentMethod === PAYMENT_METHOD.USDC &&
    !!message.paymentSessionId &&
    message.paymentSessionId === buyer?.state.summary.sessionId;
  async function checkStatus() {
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
  const explanation = shared
    ? 'An API key spending review paused Desktop and connected tools for this request. The final charge is unknown.'
    : declined
      ? 'The seller declined this question before charging you.'
      : free
        ? 'The free response was interrupted. Any text shown is incomplete.'
        : `The ${message.paymentMethod === PAYMENT_METHOD.PAYPAL ? 'PayPal' : 'USDC'} response was interrupted. The final charge is unknown.`;
  return (
    <article className="chat-answer" aria-label="Assistant">
      {message.text && <MessageText text={message.text} />}
      <Notice>
        {explanation}
        {observation && ' ' + observation}
      </Notice>
      <div className="answer-actions">
        {declined || (free && !shared) ? (
          <Button variant={BUTTON_VARIANT.SECONDARY} onClick={onEdit}>
            {separateDraft ? 'Edit in new chat' : 'Edit question'}
          </Button>
        ) : sameSession ? (
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            disabled={buyer?.busy}
            onClick={() => void checkStatus()}
          >
            Check status
          </Button>
        ) : (
          <Button variant={BUTTON_VARIANT.SECONDARY} onClick={onReview}>
            Review in Payments
          </Button>
        )}
      </div>
    </article>
  );
}
