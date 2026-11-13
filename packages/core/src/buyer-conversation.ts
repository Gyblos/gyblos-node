// Builds a bounded text conversation from caller-owned confirmed turns; no persistence or financial state.
import { isConversation, type ChatMessage } from '@gyblos/protocol/chat';
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';

export function prepareBuyerConversation(
  history: readonly ChatMessage[],
  prompt: string,
  maxBytes: number,
): ChatMessage[] | undefined {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > FREE_EXECUTION.inputBytes ||
    history.length >= FREE_EXECUTION.maxMessages ||
    !prompt.trim()
  )
    return undefined;
  const messages: ChatMessage[] = [
    ...history.map((message) => ({ ...message })),
    { role: FREE_CHAT_ROLES.USER, content: prompt },
  ];
  if (
    messages.length > FREE_EXECUTION.maxMessages ||
    messages.some(
      (message) =>
        typeof message.content !== 'string' ||
        /[\uD800-\uDFFF]/u.test(message.content),
    ) ||
    !isConversation(messages) ||
    messages.reduce(
      (total, message) =>
        total + new TextEncoder().encode(message.content).byteLength,
      0,
    ) > maxBytes
  )
    return undefined;
  return messages;
}
