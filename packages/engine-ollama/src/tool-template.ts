// The pinned Qwen3 template's tool branch, byte for byte: the tools block in the system turn, assistant
// calls as <tool_call> JSON, results as <tool_response> inside one user turn, and the reader that takes
// calls back out of what the model writes. Seller and buyer count tokens over the same rendering.
import { randomUUID } from 'node:crypto';

import type { ChatMessage } from '@gyblos/protocol/chat';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import {
  hasToolTurns,
  TOOL_CHOICES,
  TOOL_ROLE,
  type ToolCall,
  type ToolChatMessage,
  type ToolChoice,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { renderConversation } from './model';

const TOOLS_HEADER =
  '# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>';
const TOOLS_FOOTER =
  '\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';
export const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
// Template control tokens, thinking and tool tags are never content: they would let text forge turns.
const CONTROL = /<\|.*?\|>|<\/?think>|<\/?tool_call>|<\/?tool_response>/;

// The template's tojson: Python json.dumps(ensure_ascii=False) with its default separators.
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(', ')}}`;
  return JSON.stringify(value) ?? 'null';
}
function checked(text: string): string {
  if (CONTROL.test(text))
    throw new Error('Unsupported content for the chat template.');
  return text;
}
function toolLine(tool: ToolDefinition): string {
  checked(tool.name);
  checked(tool.description ?? '');
  const parameters: unknown = JSON.parse(checked(tool.parameters));
  return pythonJson({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      parameters,
    },
  });
}
// An assistant turn's body: its text, then each call; what a generation that calls tools writes.
export function renderAssistantOutput(
  text: string,
  calls: readonly ToolCall[] = [],
): string {
  let rendered = checked(text);
  calls.forEach((call, index) => {
    if (index > 0 || text) rendered += '\n';
    rendered += `${TOOL_CALL_OPEN}\n{"name": "${checked(call.name)}", "arguments": ${checked(call.arguments)}}\n${TOOL_CALL_CLOSE}`;
  });
  return rendered;
}

// A conversation with tools offered or tool turns, then the assistant's opening with an empty thought.
export function renderToolConversation(
  messages: readonly ToolChatMessage[],
  tools?: readonly ToolDefinition[],
): string {
  let rendered = '';
  let rest = messages;
  const system =
    messages[0]?.role === FREE_CHAT_ROLES.SYSTEM ? messages[0] : undefined;
  if (system) rest = messages.slice(1);
  if (tools?.length) {
    rendered += `<|im_start|>system\n${system ? `${checked(system.content)}\n\n` : ''}${TOOLS_HEADER}`;
    for (const tool of tools) rendered += `\n${toolLine(tool)}`;
    rendered += `${TOOLS_FOOTER}<|im_end|>\n`;
  } else if (system)
    rendered += `<|im_start|>system\n${checked(system.content)}<|im_end|>\n`;
  rest.forEach((message, index) => {
    if (message.role === TOOL_ROLE) {
      if (rest[index - 1]?.role !== TOOL_ROLE) rendered += '<|im_start|>user';
      rendered += `\n<tool_response>\n${checked(message.content)}\n</tool_response>`;
      if (rest[index + 1]?.role !== TOOL_ROLE) rendered += '<|im_end|>\n';
    } else if (message.role === FREE_CHAT_ROLES.ASSISTANT)
      rendered += `<|im_start|>assistant\n${renderAssistantOutput(message.content, 'toolCalls' in message ? message.toolCalls : [])}<|im_end|>\n`;
    else if (message.role === FREE_CHAT_ROLES.USER)
      rendered += `<|im_start|>user\n${checked(message.content)}<|im_end|>\n`;
    else throw new Error('Unsupported conversation for the chat template.');
  });
  return `${rendered}<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

// Ollama's calls have no id; the seller names each one, as OpenAI does.
const callId = () => `call_${randomUUID().replaceAll('-', '')}`;

// What the model wrote, split into text and calls, or undefined when it is not a well-formed run of calls
// to offered tools after optional text (the caller then keeps it all as text).
export function parseToolOutput(
  raw: string,
  tools: readonly ToolDefinition[],
  newId: () => string = callId,
): { text: string; toolCalls: ToolCall[] } | undefined {
  const start = raw.indexOf(TOOL_CALL_OPEN);
  if (start === -1) return undefined;
  const text = raw.slice(0, start).replace(/\n$/, '');
  const calls: ToolCall[] = [];
  let rest = raw.slice(start);
  while (rest.startsWith(TOOL_CALL_OPEN)) {
    const end = rest.indexOf(TOOL_CALL_CLOSE);
    if (end === -1) return undefined;
    const call = toolCall(rest.slice(TOOL_CALL_OPEN.length, end), tools, newId);
    if (!call) return undefined;
    calls.push(call);
    rest = rest.slice(end + TOOL_CALL_CLOSE.length).replace(/^\n/, '');
  }
  if (rest.trim() || CONTROL.test(text)) return undefined;
  return { text, toolCalls: calls };
}
function toolCall(
  body: string,
  tools: readonly ToolDefinition[],
  newId: () => string,
): ToolCall | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const name: unknown = Reflect.get(value, 'name');
  let args: unknown = Reflect.get(value, 'arguments') ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (
    typeof name !== 'string' ||
    !tools.some((tool) => tool.name === name) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return undefined;
  return { id: newId(), name, arguments: JSON.stringify(args) };
}

// Streams the text before any call and holds back from a possible <tool_call> onward, so a call's markup
// never reaches the buyer as text; finish() says what was held back.
export function createToolStreamSplitter() {
  let released = 0;
  let raw = '';
  let holding = false;
  return {
    // The text that is now safe to release.
    push(fragment: string): string {
      raw += fragment;
      if (holding) return '';
      const open = raw.indexOf(TOOL_CALL_OPEN, released);
      if (open !== -1) {
        holding = true;
        // The newline the template writes before a call is not part of the text.
        const end =
          raw[open - 1] === '\n' && open - 1 >= released ? open - 1 : open;
        const out = raw.slice(released, end);
        released = end;
        return out;
      }
      // Keep back a tail that could still become "\n<tool_call>".
      let keep = 0;
      for (
        let length = Math.min(TOOL_CALL_OPEN.length, raw.length - released);
        length > 0;
        length--
      )
        if (TOOL_CALL_OPEN.startsWith(raw.slice(raw.length - length))) {
          keep = length;
          break;
        }
      if (keep && raw[raw.length - keep - 1] === '\n') keep++;
      else if (!keep && raw.endsWith('\n')) keep = 1;
      const end = raw.length - keep;
      const out = end > released ? raw.slice(released, end) : '';
      if (end > released) released = end;
      return out;
    },
    raw: () => raw,
    // Whatever was held back and not yet released.
    held: () => raw.slice(released),
  };
}

// One input rendering for engine and public recount; choice none excludes the offered definitions.
export function renderInferenceConversation(
  messages: readonly ToolChatMessage[],
  tools?: readonly ToolDefinition[],
  choice?: ToolChoice,
) {
  const offered =
    tools?.length && choice !== TOOL_CHOICES.NONE ? tools : undefined;
  return {
    tools: offered,
    prompt:
      offered || hasToolTurns(messages)
        ? renderToolConversation(messages, offered)
        : renderConversation(messages as readonly ChatMessage[]),
  };
}
