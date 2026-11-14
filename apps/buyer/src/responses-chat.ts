// Reads OpenAI's Responses API request, the one Codex CLI sends, into the conversation sellers serve:
// instructions and leading developer or system messages first, then user and assistant turns, an
// assistant's function calls grouped into one turn and answered by their outputs. Requests are stateless:
// every one carries the whole conversation, so a client may switch models between turns. Item and tool
// types this endpoint cannot serve (reasoning, custom or provider-run tools, images) are refused by name.
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  parseToolCalls,
  TOOL_CHOICES,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { chatConversation, type ChatTurn } from './chat-messages';
import { openAiTools } from './chat-tools';
import {
  CHAT_MESSAGE_DETAILS,
  FREE_CHAT_DETAILS,
  FREE_CHAT_FIELD_NAME,
  OPENAI_CHAT,
  RESPONSES_CHAT,
} from './constants';
import {
  chatObject,
  checkFields,
  checkModel,
  checkStream,
  invalidChat,
  outputTokens,
  toolInput,
  type FreeChatInput,
} from './free-chat';

type Row = Record<string, unknown>;
const INPUT = 'input';
const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const refuse = () => invalidChat(INPUT, FREE_CHAT_DETAILS.responsesInput);
// A type is named back only when it looks like a plain identifier, never arbitrary request text.
const typeName = (value: unknown) =>
  typeof value === 'string' && FREE_CHAT_FIELD_NAME.test(value)
    ? value
    : 'unknown';
function only(row: Row, keys: readonly string[]) {
  if (Object.keys(row).some((key) => !keys.includes(key))) throw refuse();
}

// Text content: a string, or input_text / output_text parts. An image (a pasted picture, or what Codex's
// view_image returns) becomes a short placeholder: Codex resends its whole history every turn, so refusing
// it would end the session. Audio, files and other parts are refused.
function itemText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) throw refuse();
  return value
    .map((part: unknown) => {
      if (!isRow(part)) throw refuse();
      if (part.type === 'input_image') return RESPONSES_CHAT.imagePlaceholder;
      if (!RESPONSES_CHAT.textParts.includes(String(part.type)))
        throw invalidChat(INPUT, CHAT_MESSAGE_DETAILS.parts);
      only(part, RESPONSES_CHAT.partFields);
      if (typeof part.text !== 'string') throw refuse();
      return part.text;
    })
    .join('\n\n');
}

// A function_call item's call, unchecked; the calls of one turn are checked together (unique ids, count).
function functionCall(item: Row) {
  only(item, RESPONSES_CHAT.callFields);
  return {
    id: item.call_id,
    name: item.name,
    arguments: item.arguments || '{}',
  };
}
function toolCalls(calls: unknown[]): ToolCall[] {
  try {
    return parseToolCalls(calls);
  } catch {
    throw invalidChat(INPUT, CHAT_MESSAGE_DETAILS.toolCalls);
  }
}

function callOutput(item: Row): ChatTurn {
  only(item, RESPONSES_CHAT.outputFields);
  if (typeof item.call_id !== 'string')
    throw invalidChat(INPUT, CHAT_MESSAGE_DETAILS.toolCalls);
  return {
    role: 'tool',
    text: itemText(item.output),
    toolCallId: item.call_id,
  };
}

// The conversation: leading instructions as system text, later developer or system messages (Codex sends
// one when the model changes) as user text, so the turn order holds.
function conversation(input: unknown, instructions: string[]): ChatTurn[] {
  const items =
    typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  if (!Array.isArray(items) || !items.length) throw refuse();
  const turns: ChatTurn[] = [];
  let calls: unknown[] | undefined;
  const flush = () => {
    if (calls)
      turns.push({ role: 'assistant', text: '', toolCalls: toolCalls(calls) });
    calls = undefined;
  };
  for (const entry of items) {
    if (!isRow(entry)) throw refuse();
    const type = entry.type ?? 'message';
    // The record of a model's reasoning or of a provider's own search, kept by a session that began on
    // another provider: nothing to answer, so it is left out and the switch keeps working.
    if (RESPONSES_CHAT.skippedItems.includes(String(type))) continue;
    if (type === 'function_call') {
      (calls ??= []).push(functionCall(entry));
      continue;
    }
    flush();
    if (type === 'function_call_output') turns.push(callOutput(entry));
    else if (type === 'message') {
      only(entry, RESPONSES_CHAT.messageFields);
      const role = OPENAI_CHAT.roles[String(entry.role)];
      if (!role) throw refuse();
      const text = itemText(entry.content);
      if (role !== 'system') turns.push({ role, text });
      else if (turns.length) turns.push({ role: 'user', text });
      else instructions.push(text);
    } else
      throw invalidChat(
        INPUT,
        FREE_CHAT_DETAILS.responsesItem(typeName(entry.type)),
      );
  }
  flush();
  return turns;
}

// Function tools in the Responses shape (flat: {type, name, description?, parameters?, strict?}), read
// through the Chat Completions checks. Web search and tool groups (namespaces), which Codex sends on every
// request, are left out: no seller runs them, so the model is simply not offered them. Custom and other
// provider tools are refused by type.
function responsesTools(value: unknown): ToolDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw invalidChat('tools', FREE_CHAT_DETAILS.tools);
  const offered = value.filter(
    (tool: unknown) =>
      !(isRow(tool) && RESPONSES_CHAT.skippedTools.includes(String(tool.type))),
  );
  return openAiTools(
    offered.map((tool: unknown) => {
      if (!isRow(tool)) throw invalidChat('tools', FREE_CHAT_DETAILS.tools);
      if (tool.type !== 'function')
        throw invalidChat(
          'tools',
          FREE_CHAT_DETAILS.responsesTool(typeName(tool.type)),
        );
      only(tool, RESPONSES_CHAT.toolFields);
      const { type, ...fn } = tool;
      return { type, function: fn };
    }),
  );
}

function responsesToolChoice(value: unknown): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  for (const choice of Object.values(TOOL_CHOICES))
    if (value === choice) return choice;
  if (
    isRow(value) &&
    value.type === 'function' &&
    typeof value.name === 'string'
  )
    return { name: value.name };
  throw invalidChat('tool_choice', FREE_CHAT_DETAILS.toolChoice);
}

export function parseResponsesChat(
  value: unknown,
  selection: ModelSelection,
  maximum: number,
  allowStreaming = false,
  allowTools = true,
): FreeChatInput {
  const row = chatObject(value);
  checkFields(row, RESPONSES_CHAT.fields);
  checkModel(row, selection);
  const stream = checkStream(row, allowStreaming);
  const instructions =
    row.instructions === undefined || row.instructions === null
      ? []
      : [itemText(row.instructions)];
  const turns = conversation(row.input, instructions);
  const messages = chatConversation(instructions, turns);
  return {
    messages,
    maxTokens: outputTokens(
      row.max_output_tokens,
      'max_output_tokens',
      maximum,
    ),
    ...toolInput(
      responsesTools(row.tools),
      responsesToolChoice(row.tool_choice),
      messages,
      allowTools,
    ),
    ...stream,
  };
}
