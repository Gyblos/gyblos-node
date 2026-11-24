// Describes conversation contents without deriving charges from displayed responses.
import { PAYMENT_METHOD } from '../paypal-model';
import type { ChatMessage, ChatSession } from './chat-state';
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
      (message) =>
        message.paymentMethod === PAYMENT_METHOD.USDC &&
        !message.paymentSessionId,
    ).length,
    x402Replies: replies.filter(
      (message) =>
        message.paymentMethod === PAYMENT_METHOD.USDC &&
        !!message.paymentSessionId,
    ).length,
    paymentSessionIds: [
      ...new Set(
        session.messages.flatMap((message) =>
          message.paymentSessionId ? [message.paymentSessionId] : [],
        ),
      ),
    ],
    x402SessionIds: [
      ...new Set(
        session.messages.flatMap((message) =>
          message.paymentMethod === PAYMENT_METHOD.USDC &&
          message.paymentSessionId
            ? [message.paymentSessionId]
            : [],
        ),
      ),
    ],
    lastSentAt: sent.length ? Math.max(...sent) : null,
  };
}

function closeMarkdownFence(text: string) {
  let fence = '';
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const marker = match[1];
    const suffix = match[2] ?? '';
    if (fence) {
      if (marker.startsWith(fence) && !suffix.trim()) fence = '';
    } else if (marker.startsWith('~') || !suffix.includes('`')) {
      fence = marker;
    }
  }
  return fence ? text + '\n' + fence : text;
}

export function conversationMarkdown(
  title: string,
  messages: readonly Pick<ChatMessage, 'role' | 'text'>[],
) {
  return [
    '# ' + title,
    ...messages.map(
      (message) =>
        (message.role === CHAT_ROLE.USER ? '**You:**' : '**Gyblos:**') +
        '\n\n' +
        closeMarkdownFence(message.text),
    ),
  ].join('\n\n');
}
