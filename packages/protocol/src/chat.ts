// A conversation as engines receive it: an optional system message first, then user and assistant turns
// alternating from the user's and ending with it, each with text. Shape only: sizes are the wire's, and the
// context the seller's.
import { FREE_CHAT_ROLES, type FreeChatRole } from './constants';

export interface ChatMessage {
  role: FreeChatRole;
  content: string;
}

// After the optional system message, turns alternate user, assistant, user and end with the user's, as
// every engine template accepts; the buyer merges consecutive turns of one role before sending.
export function isConversation(messages: readonly ChatMessage[]): boolean {
  const turns =
    messages[0]?.role === FREE_CHAT_ROLES.SYSTEM ? messages.slice(1) : messages;
  if (turns.length % 2 === 0) return false;
  return (
    messages.every((message) => message.content.length > 0) &&
    turns.every(
      (turn, index) =>
        turn.role ===
        (index % 2 === 0 ? FREE_CHAT_ROLES.USER : FREE_CHAT_ROLES.ASSISTANT),
    )
  );
}
