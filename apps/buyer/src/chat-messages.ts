// Turns the messages an OpenAI- or Anthropic-style client sends into the conversation sellers serve: system
// text first, then user and assistant turns alternating from the user's and ending with it. Consecutive turns
// of one role are joined, as both APIs allow; tool turns, images and other non-text parts are refused, never
// dropped. Refusals name the field and a fixed reason, never the text.
import type { ChatMessage } from '@gyblos/protocol/chat';
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';

import { CHAT_MESSAGE_DETAILS, FREE_CHAT_FIELDS } from './constants';
import { invalidChat } from './free-chat-error';

export interface ChatTurn {
  role: ChatMessage['role'];
  text: string;
}

const JOIN = '\n\n';

const refuse = (detail: string) =>
  invalidChat(FREE_CHAT_FIELDS.MESSAGES, detail);

// Text parts as both APIs send them; any other part (image, audio, tool use or result) is refused.
export function partsText(
  value: unknown,
  allowed: readonly string[],
): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const texts: string[] = [];
  for (const part of value) {
    if (!part || typeof part !== 'object' || Array.isArray(part))
      return undefined;
    const row = part as Record<string, unknown>;
    if (row.type !== 'text') throw refuse(CHAT_MESSAGE_DETAILS.parts);
    if (
      typeof row.text !== 'string' ||
      Object.keys(row).some((key) => !allowed.includes(key))
    )
      return undefined;
    texts.push(row.text);
  }
  return texts.join(JOIN);
}

export function textOf(value: unknown, allowed: readonly string[]) {
  const text = partsText(value, allowed);
  if (text === undefined) throw refuse(CHAT_MESSAGE_DETAILS.shape);
  return text;
}

// Leading system text becomes one system message; turns of one role in a row become one turn.
export function chatConversation(
  system: readonly string[],
  turns: readonly ChatTurn[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const instructions = system.filter((text) => text.length > 0).join(JOIN);
  if (instructions)
    messages.push({ role: FREE_CHAT_ROLES.SYSTEM, content: instructions });
  for (const turn of turns) {
    if (turn.role === FREE_CHAT_ROLES.SYSTEM)
      throw refuse(CHAT_MESSAGE_DETAILS.order);
    if (turn.text.length === 0) continue;
    const last = messages.at(-1);
    if (last && last.role === turn.role) last.content += JOIN + turn.text;
    else messages.push({ role: turn.role, content: turn.text });
  }
  const first = messages.find(
    (message) => message.role !== FREE_CHAT_ROLES.SYSTEM,
  );
  if (
    first?.role !== FREE_CHAT_ROLES.USER ||
    messages.at(-1)?.role !== FREE_CHAT_ROLES.USER
  )
    throw refuse(CHAT_MESSAGE_DETAILS.order);
  if (messages.length > FREE_EXECUTION.maxMessages)
    throw refuse(CHAT_MESSAGE_DETAILS.count);
  const bytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content),
    0,
  );
  if (
    bytes > FREE_EXECUTION.inputBytes ||
    messages.some((message) => /[\uD800-\uDFFF]/u.test(message.content))
  )
    throw refuse(CHAT_MESSAGE_DETAILS.content);
  return messages;
}
