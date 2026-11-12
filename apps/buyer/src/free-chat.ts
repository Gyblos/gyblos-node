// Validates the supported OpenAI-compatible subset: a whole conversation of text turns, tools and tool turns.
// Options clients send by default and that do not change what is asked are accepted and ignored; options
// that would (structured output, several answers, stop sequences) are refused, never silently dropped.
import type { ModelSelection } from '@gyblos/protocol/control-types';
import { controlInteger } from '@gyblos/protocol/control-validation';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { hasToolTurns } from '@gyblos/protocol/tools';

import { chatConversation, textOf, type ChatTurn } from './chat-messages';
import { openAiCalls, openAiToolChoice, openAiTools } from './chat-tools';
import {
  CHAT_MESSAGE_DETAILS,
  FREE_CHAT_DETAILS,
  FREE_CHAT_FIELD_NAME,
  FREE_CHAT_FIELDS,
  OPENAI_CHAT,
} from './constants';
import { invalidChat } from './free-chat-error';

export { FreeBuyerError, invalidChat } from './free-chat-error';

export interface FreeChatInput extends FreeExecutionBuildInput {
  stream?: true;
}

type Row = Record<string, unknown>;

export function chatObject(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidChat(null, FREE_CHAT_DETAILS.body);
  return value as Row;
}

export interface ChatFieldRules {
  supported: readonly string[];
  ignored: readonly string[];
  neutral: Readonly<Record<string, (value: unknown) => boolean>>;
}

// Every field is supported, ignored, or refused unless it holds the value that changes nothing.
export function checkFields(row: Row, fields: ChatFieldRules) {
  for (const key of Object.keys(row)) {
    if (fields.supported.includes(key) || fields.ignored.includes(key))
      continue;
    const neutral = fields.neutral[key];
    if (neutral) {
      if (!neutral(row[key]))
        throw invalidChat(key, FREE_CHAT_DETAILS.unsupported(key));
      continue;
    }
    throw invalidChat(
      FREE_CHAT_FIELD_NAME.test(key) ? key : null,
      FREE_CHAT_DETAILS.fields,
    );
  }
}

export function checkModel(row: Row, selection: ModelSelection) {
  if (row.model !== selection.modelId)
    throw invalidChat(
      FREE_CHAT_FIELDS.MODEL,
      FREE_CHAT_DETAILS.model(selection.modelId),
    );
}

// Tools and a tool choice for the request; a choice of none without tools asks for nothing.
export function toolInput(
  tools: FreeChatInput['tools'],
  toolChoice: FreeChatInput['toolChoice'],
  messages: FreeChatInput['messages'],
  allowed: boolean,
): Pick<FreeChatInput, 'tools' | 'toolChoice'> {
  // An endpoint that may route to paid execution serves text only, never dropping tools silently.
  if (!allowed && (tools || hasToolTurns(messages)))
    throw invalidChat('tools', FREE_CHAT_DETAILS.paidTools);
  if (!tools) {
    if (toolChoice === undefined || toolChoice === 'none') return {};
    throw invalidChat('tool_choice', FREE_CHAT_DETAILS.toolChoice);
  }
  if (
    typeof toolChoice === 'object' &&
    !tools.some((tool) => tool.name === toolChoice.name)
  )
    throw invalidChat('tool_choice', FREE_CHAT_DETAILS.toolChoice);
  return { tools, ...(toolChoice ? { toolChoice } : {}) };
}

export function checkStream(row: Row, allowStreaming: boolean) {
  if (
    Object.hasOwn(row, FREE_CHAT_FIELDS.STREAM) &&
    row.stream !== false &&
    !(allowStreaming && row.stream === true)
  )
    throw invalidChat(
      FREE_CHAT_FIELDS.STREAM,
      allowStreaming ? FREE_CHAT_DETAILS.stream : FREE_CHAT_DETAILS.noStream,
    );
  return row.stream === true ? { stream: true as const } : {};
}

// A requested length above this buyer's maximum is served up to the maximum, as a provider serves a model's
// own limit; the answer then ends with finish reason `length`.
export function outputTokens(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (value === undefined || value === null) return maximum;
  try {
    return Math.min(controlInteger(value, 1), maximum);
  } catch {
    throw invalidChat(field, FREE_CHAT_DETAILS.maxTokens);
  }
}

function requestedTokens(row: Row, maximum: number) {
  const legacy = row[FREE_CHAT_FIELDS.MAX_TOKENS];
  const current = row[FREE_CHAT_FIELDS.MAX_COMPLETION_TOKENS];
  if (legacy != null && current != null && legacy !== current)
    throw invalidChat(
      FREE_CHAT_FIELDS.MAX_COMPLETION_TOKENS,
      FREE_CHAT_DETAILS.bothMaxTokens,
    );
  return current != null
    ? outputTokens(current, FREE_CHAT_FIELDS.MAX_COMPLETION_TOKENS, maximum)
    : outputTokens(legacy, FREE_CHAT_FIELDS.MAX_TOKENS, maximum);
}

function chatMessage(entry: unknown): Row {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
  const message = entry as Row;
  if (message.role === 'function' || message.function_call != null)
    throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.tools);
  if (
    Object.keys(message).some((key) => !OPENAI_CHAT.messageFields.includes(key))
  )
    throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
  return message;
}

function openAiConversation(value: unknown) {
  if (!Array.isArray(value) || value.length === 0)
    throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
  const system: string[] = [];
  const turns: ChatTurn[] = [];
  for (const entry of value) {
    const message = chatMessage(entry);
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string')
        throw invalidChat(
          FREE_CHAT_FIELDS.MESSAGES,
          CHAT_MESSAGE_DETAILS.toolCalls,
        );
      turns.push({
        role: 'tool',
        text:
          message.content == null
            ? ''
            : textOf(message.content, OPENAI_CHAT.partFields),
        toolCallId: message.tool_call_id,
      });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls != null) {
      turns.push({
        role: 'assistant',
        text:
          message.content == null
            ? ''
            : textOf(message.content, OPENAI_CHAT.partFields),
        toolCalls: openAiCalls(message.tool_calls),
      });
      continue;
    }
    const role = OPENAI_CHAT.roles[String(message.role)];
    if (!role)
      throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
    const text = textOf(message.content, OPENAI_CHAT.partFields);
    // System and developer instructions before the first turn lead the conversation; later ones are
    // refused by the conversation check rather than moved.
    if (role === 'system' && turns.length === 0) system.push(text);
    else turns.push({ role, text });
  }
  return chatConversation(system, turns);
}

export function parseFreeChat(
  value: unknown,
  selection: ModelSelection,
  maximum: number,
  allowStreaming = false,
  allowTools = true,
): FreeChatInput {
  const row = chatObject(value);
  checkFields(row, OPENAI_CHAT.fields);
  checkModel(row, selection);
  const stream = checkStream(row, allowStreaming);
  const messages = openAiConversation(row.messages);
  return {
    messages,
    maxTokens: requestedTokens(row, maximum),
    ...toolInput(
      openAiTools(row.tools),
      openAiToolChoice(row.tool_choice),
      messages,
      allowTools,
    ),
    ...stream,
  };
}
