// Turns the messages an OpenAI- or Anthropic-style client sends into the conversation sellers serve: system
// text first, then user and assistant turns alternating from the user's, with an assistant's tool calls
// answered by tool results, ending with the user or with results. Consecutive text turns of one role are
// joined, as both APIs allow; images and other non-text parts are refused, never dropped. Refusals name the
// field and a fixed reason, never the text.
import { isConversation, type ChatMessage } from '@gyblos/protocol/chat';
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';
import {
  hasToolTurns,
  isToolConversation,
  TOOL_ROLE,
  toolMessageBytes,
  type ToolCall,
  type ToolChatMessage,
} from '@gyblos/protocol/tools';

import { CHAT_MESSAGE_DETAILS, FREE_CHAT_FIELDS } from './constants';
import { invalidChat } from './free-chat-error';

// A text turn, an assistant turn that calls tools, or a tool's result.
export type ChatTurn =
  | { role: ChatMessage['role']; text: string; toolCalls?: ToolCall[] }
  | { role: typeof TOOL_ROLE; text: string; toolCallId: string };

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

// Joins a text turn into the one before it when both are text of one role (an assistant's text may also
// lead its calls); returns false when the turn starts a new message.
function joined(last: ToolChatMessage | undefined, turn: ChatTurn) {
  if (!last || last.role !== turn.role || last.role === TOOL_ROLE) return false;
  if ('toolCalls' in last) throw refuse(CHAT_MESSAGE_DETAILS.order);
  if ('toolCalls' in turn && turn.toolCalls) {
    Object.assign(last, {
      content: [last.content, turn.text].filter(Boolean).join(JOIN),
      toolCalls: turn.toolCalls,
    });
    return true;
  }
  last.content += JOIN + turn.text;
  return true;
}
function message(turn: ChatTurn): ToolChatMessage {
  if ('toolCallId' in turn)
    return { role: TOOL_ROLE, content: turn.text, toolCallId: turn.toolCallId };
  if (turn.toolCalls)
    return {
      role: FREE_CHAT_ROLES.ASSISTANT,
      content: turn.text,
      toolCalls: turn.toolCalls,
    };
  return { role: turn.role, content: turn.text };
}

// Leading system text becomes one system message; text turns of one role in a row become one turn.
export function chatConversation(
  system: readonly string[],
  turns: readonly ChatTurn[],
): ToolChatMessage[] {
  const messages: ToolChatMessage[] = [];
  const instructions = system.filter((text) => text.length > 0).join(JOIN);
  if (instructions)
    messages.push({ role: FREE_CHAT_ROLES.SYSTEM, content: instructions });
  for (const turn of turns) {
    if (turn.role === FREE_CHAT_ROLES.SYSTEM)
      throw refuse(CHAT_MESSAGE_DETAILS.order);
    const calls = 'toolCalls' in turn && turn.toolCalls;
    if (turn.text.length === 0 && turn.role !== TOOL_ROLE && !calls) continue;
    if (!joined(messages.at(-1), turn)) messages.push(message(turn));
  }
  if (
    !(hasToolTurns(messages)
      ? isToolConversation(messages)
      : isConversation(messages as ChatMessage[]))
  )
    throw refuse(CHAT_MESSAGE_DETAILS.order);
  if (messages.length > FREE_EXECUTION.maxMessages)
    throw refuse(CHAT_MESSAGE_DETAILS.count);
  const bytes = messages.reduce(
    (total, message) => total + toolMessageBytes(message),
    0,
  );
  if (
    bytes > FREE_EXECUTION.inputBytes ||
    messages.some((message) => /[\uD800-\uDFFF]/u.test(message.content))
  )
    throw refuse(CHAT_MESSAGE_DETAILS.content);
  return messages;
}
