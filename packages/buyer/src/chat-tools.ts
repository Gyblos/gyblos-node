// Tool calling in the two client formats: OpenAI functions and tool_calls, Anthropic tools and tool_use /
// tool_result blocks, read into the protocol's tools and turns, and the calls of a result written back.
// Refusals name the field and a fixed reason, never the request's text.
import {
  parseToolCalls,
  parseTools,
  TOOL_CHOICES,
  TOOL_ROLE,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import type { ChatTurn } from './chat-messages';
import { CHAT_MESSAGE_DETAILS, FREE_CHAT_DETAILS } from './constants';
import { invalidChat } from './free-chat-error';

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const absent = (value: unknown) => value === undefined || value === null;
const EMPTY_SCHEMA = { type: 'object', properties: {} };

// The protocol's own checks, with a refusal that names the field.
function checked<T>(field: string, detail: string, read: () => T): T {
  try {
    return read();
  } catch {
    throw invalidChat(field, detail);
  }
}
function only(
  row: Row,
  keys: readonly string[],
  field: string,
  detail: string,
) {
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw invalidChat(field, detail);
}
function definitions(
  entries: { name: unknown; description: unknown; schema: unknown }[],
): ToolDefinition[] {
  return checked('tools', FREE_CHAT_DETAILS.tools, () =>
    parseTools(
      entries.map(({ name, description, schema }) => ({
        name,
        ...(typeof description === 'string' && description
          ? { description }
          : {}),
        parameters: JSON.stringify(schema ?? EMPTY_SCHEMA),
      })),
    ),
  );
}

// OpenAI: [{type: 'function', function: {name, description?, parameters?, strict?}}].
export function openAiTools(value: unknown): ToolDefinition[] | undefined {
  if (absent(value) || (Array.isArray(value) && !value.length)) return;
  if (!Array.isArray(value))
    throw invalidChat('tools', FREE_CHAT_DETAILS.tools);
  return definitions(
    value.map((entry: unknown) => {
      if (!isRow(entry) || entry.type !== 'function' || !isRow(entry.function))
        throw invalidChat('tools', FREE_CHAT_DETAILS.tools);
      only(entry, ['type', 'function'], 'tools', FREE_CHAT_DETAILS.tools);
      const fn = entry.function;
      only(
        fn,
        ['name', 'description', 'parameters', 'strict'],
        'tools',
        FREE_CHAT_DETAILS.tools,
      );
      return {
        name: fn.name,
        description: fn.description,
        schema: fn.parameters,
      };
    }),
  );
}
export function openAiToolChoice(value: unknown): ToolChoice | undefined {
  if (absent(value)) return;
  for (const choice of Object.values(TOOL_CHOICES))
    if (value === choice) return choice;
  if (isRow(value) && value.type === 'function' && isRow(value.function))
    return { name: String(value.function.name) };
  throw invalidChat('tool_choice', FREE_CHAT_DETAILS.toolChoice);
}
// An assistant message's tool_calls: [{id, type: 'function', function: {name, arguments}}].
export function openAiCalls(value: unknown): ToolCall[] {
  return checked('messages', CHAT_MESSAGE_DETAILS.toolCalls, () => {
    if (!Array.isArray(value)) throw new Error();
    return parseToolCalls(
      value.map((call: unknown) => {
        if (!isRow(call) || !isRow(call.function)) throw new Error();
        return {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        };
      }),
    );
  });
}
export const openAiCallsOut = (calls: readonly ToolCall[]) =>
  calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));

// Anthropic client tools; server tools (web search, code execution, ...) run at Anthropic and are refused.
const ANTHROPIC_TOOL_FIELDS = [
  'name',
  'description',
  'input_schema',
  'type',
  'cache_control',
  'strict',
  'defer_loading',
  'eager_input_streaming',
  'input_examples',
];
export function anthropicTools(value: unknown): ToolDefinition[] | undefined {
  if (absent(value) || (Array.isArray(value) && !value.length)) return;
  if (!Array.isArray(value))
    throw invalidChat('tools', FREE_CHAT_DETAILS.tools);
  return definitions(
    value.map((entry: unknown) => {
      if (!isRow(entry)) throw invalidChat('tools', FREE_CHAT_DETAILS.tools);
      if (!absent(entry.type) && entry.type !== 'custom')
        throw invalidChat('tools', FREE_CHAT_DETAILS.serverTools);
      only(entry, ANTHROPIC_TOOL_FIELDS, 'tools', FREE_CHAT_DETAILS.tools);
      return {
        name: entry.name,
        description: entry.description,
        schema: entry.input_schema,
      };
    }),
  );
}
const ANTHROPIC_CHOICES: Readonly<Record<string, ToolChoice>> = {
  auto: TOOL_CHOICES.AUTO,
  any: TOOL_CHOICES.REQUIRED,
  none: TOOL_CHOICES.NONE,
};
export function anthropicToolChoice(value: unknown): ToolChoice | undefined {
  if (absent(value)) return;
  if (isRow(value)) {
    if (value.type === 'tool') return { name: String(value.name) };
    const choice = ANTHROPIC_CHOICES[String(value.type)];
    if (choice) return choice;
  }
  throw invalidChat('tool_choice', FREE_CHAT_DETAILS.toolChoice);
}

// One block list's text, from text parts only; the caller decides what else a block may be.
function blockText(blocks: readonly Row[]) {
  return blocks.map((block) => block.text as string).join('\n\n');
}
function resultText(value: unknown): string {
  if (absent(value)) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value))
    throw invalidChat('messages', CHAT_MESSAGE_DETAILS.shape);
  for (const part of value)
    if (!isRow(part) || part.type !== 'text' || typeof part.text !== 'string')
      throw invalidChat('messages', CHAT_MESSAGE_DETAILS.parts);
  return blockText(value as Row[]);
}
// An Anthropic message's blocks as turns: an assistant's text and tool_use calls; a user's tool results
// (each a tool turn, marked when it reports an error) and then its text. Thinking blocks are the client's
// record of a model's reasoning and are left out; images and documents are refused.
export function anthropicBlockTurns(
  role: string,
  blocks: readonly unknown[],
): ChatTurn[] {
  const texts: Row[] = [];
  const calls: unknown[] = [];
  const results: ChatTurn[] = [];
  for (const block of blocks) {
    if (!isRow(block))
      throw invalidChat('messages', CHAT_MESSAGE_DETAILS.shape);
    if (block.type === 'text' && typeof block.text === 'string')
      texts.push(block);
    else if (block.type === 'thinking' || block.type === 'redacted_thinking')
      continue;
    else if (block.type === 'tool_use' && role === 'assistant')
      calls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    else if (block.type === 'tool_result' && role === 'user') {
      const text = resultText(block.content);
      results.push({
        role: TOOL_ROLE,
        text: block.is_error === true ? `Error: ${text}` : text,
        toolCallId: String(block.tool_use_id),
      });
    } else throw invalidChat('messages', CHAT_MESSAGE_DETAILS.parts);
  }
  const text = blockText(texts);
  if (role !== 'assistant') return [...results, { role: 'user', text }];
  if (!calls.length) return [{ role: 'assistant', text }];
  return [
    {
      role: 'assistant',
      text,
      toolCalls: checked('messages', CHAT_MESSAGE_DETAILS.toolCalls, () =>
        parseToolCalls(calls),
      ),
    },
  ];
}
export const anthropicToolUse = (calls: readonly ToolCall[]) =>
  calls.map((call) => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: JSON.parse(call.arguments) as unknown,
  }));
