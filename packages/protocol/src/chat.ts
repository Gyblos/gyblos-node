// A conversation as engines receive it: an optional system message first, then user and assistant turns
// ending with the user's, each with text. Shape only: sizes are the wire's, and the context the seller's.
import { FREE_CHAT_ROLES, type FreeChatRole } from './constants';

export interface ChatMessage {
  role: FreeChatRole;
  content: string;
}

export function isConversation(messages: readonly ChatMessage[]): boolean {
  if (messages.at(-1)?.role !== FREE_CHAT_ROLES.USER) return false;
  return messages.every(
    (message, index) =>
      message.content.length > 0 &&
      (message.role !== FREE_CHAT_ROLES.SYSTEM || index === 0),
  );
}
