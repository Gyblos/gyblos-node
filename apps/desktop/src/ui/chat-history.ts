// Describes conversation contents without deriving charges from displayed responses.
import { PAYMENT_METHOD } from '../paypal-model';
import type { ChatSession } from './chat-state';
import { CHAT_ROLE, MESSAGE_STATE } from './constants';

export function conversationSummary(session: ChatSession) {
  const replies = session.messages.filter(
    (message) =>
      message.role === CHAT_ROLE.ASSISTANT &&
      message.state === MESSAGE_STATE.COMPLETE,
  );
  const sent = session.messages.flatMap((message) =>
    message.sentAt === null ? [] : [message.sentAt],
  );
  return {
    prompts: session.messages.filter(
      (message) => message.role === CHAT_ROLE.USER,
    ).length,
    paypalReplies: replies.filter(
      (message) => message.paymentMethod === PAYMENT_METHOD.PAYPAL,
    ).length,
    previewReplies: replies.filter(
      (message) => message.paymentMethod === PAYMENT_METHOD.USDC,
    ).length,
    paymentSessionIds: [
      ...new Set(
        session.messages.flatMap((message) =>
          message.paymentSessionId ? [message.paymentSessionId] : [],
        ),
      ),
    ],
    lastSentAt: sent.length ? Math.max(...sent) : null,
  };
}
