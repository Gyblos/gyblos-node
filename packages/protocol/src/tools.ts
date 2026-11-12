// Tool calling on the free channel: the definitions a buyer offers the model, the calls the model makes and
// the results that answer them, as optional fields beside the text conversation. JSON values (a tool's
// parameter schema, a call's arguments) travel as JSON text, as OpenAI sends them, so signing and digests
// never reorder or round them. Shape only: whether an engine serves tools is the seller's.
import type { ChatMessage } from './chat';
import { FREE_CHAT_ROLES, FREE_EXECUTION_CODES } from './constants';
import { controlArray, controlObject } from './control-validation';
import {
  freeExecutionFail,
  freeExecutionText,
} from './free-execution-validation';

export const TOOL_ROLE = 'tool';
export const TOOL_CALLS_DONE = 'tool_calls';
export const TOOL_CHOICES = {
  AUTO: 'auto',
  NONE: 'none',
  REQUIRED: 'required',
} as const;
export const TOOL_LIMITS = {
  maxTools: 128,
  maxCallsPerTurn: 32,
  nameCharacters: 64,
  idCharacters: 64,
  descriptionBytes: 8192,
  // A schema or one call's arguments; the whole input still counts against the channel's input bound.
  jsonBytes: 65536,
} as const;

export interface ToolDefinition {
  name: string;
  description?: string;
  // A JSON Schema object, as JSON text.
  parameters: string;
}
export interface ToolCall {
  id: string;
  name: string;
  // A JSON object, as JSON text.
  arguments: string;
}
export type ToolChoice =
  (typeof TOOL_CHOICES)[keyof typeof TOOL_CHOICES] | { name: string };
export interface AssistantToolMessage {
  role: typeof FREE_CHAT_ROLES.ASSISTANT;
  content: string;
  toolCalls: ToolCall[];
}
export interface ToolResultMessage {
  role: typeof TOOL_ROLE;
  content: string;
  toolCallId: string;
}
// A text message, an assistant turn that calls tools, or a tool's result.
export type ToolChatMessage =
  ChatMessage | AssistantToolMessage | ToolResultMessage;
export interface ToolInput {
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

const NAME = /^[A-Za-z0-9_-]+$/;
const ID = /^[\x21-\x7e]+$/;
const bytes = (text: string) => new TextEncoder().encode(text).length;

function text(value: unknown, maxBytes: number, empty = false): string {
  const checked = freeExecutionText(value, maxBytes);
  if (!empty && !checked) return freeExecutionFail();
  return checked;
}
export function toolName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > TOOL_LIMITS.nameCharacters ||
    !NAME.test(value)
  )
    return freeExecutionFail();
  return value;
}
function toolId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > TOOL_LIMITS.idCharacters ||
    !ID.test(value)
  )
    return freeExecutionFail();
  return value;
}
// JSON text holding one object.
export function jsonObjectText(value: unknown): string {
  const source = text(value, TOOL_LIMITS.jsonBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return freeExecutionFail();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return freeExecutionFail();
  return source;
}

export function parseTools(value: unknown): ToolDefinition[] {
  const entries = controlArray(value, TOOL_LIMITS.maxTools);
  if (!entries.length) return freeExecutionFail();
  const names = new Set<string>();
  return entries.map((entry) => {
    const described =
      !!entry &&
      typeof entry === 'object' &&
      Object.hasOwn(entry, 'description');
    const tool = controlObject(entry, [
      'name',
      ...(described ? ['description'] : []),
      'parameters',
    ]);
    const name = toolName(tool.name);
    if (names.has(name)) return freeExecutionFail();
    names.add(name);
    return {
      name,
      ...(described
        ? { description: text(tool.description, TOOL_LIMITS.descriptionBytes) }
        : {}),
      parameters: jsonObjectText(tool.parameters),
    };
  });
}
export function parseToolChoice(value: unknown): ToolChoice {
  for (const choice of Object.values(TOOL_CHOICES))
    if (value === choice) return choice;
  return { name: toolName(controlObject(value, ['name']).name) };
}
export function parseToolCalls(value: unknown): ToolCall[] {
  const entries = controlArray(value, TOOL_LIMITS.maxCallsPerTurn);
  if (!entries.length) return freeExecutionFail();
  const ids = new Set<string>();
  return entries.map((entry) => {
    const call = controlObject(entry, ['id', 'name', 'arguments']);
    const id = toolId(call.id);
    if (ids.has(id)) return freeExecutionFail();
    ids.add(id);
    return {
      id,
      name: toolName(call.name),
      arguments: jsonObjectText(call.arguments),
    };
  });
}
// One wire message: the text fields, plus toolCalls on an assistant turn or toolCallId on a tool result.
// Content counts against inputBytes by the caller; tool JSON is bounded here per value.
export function parseToolMessage(
  value: unknown,
  role: (value: unknown) => ChatMessage['role'],
  inputBytes: number,
): ToolChatMessage {
  const raw = value && typeof value === 'object' ? value : {};
  if (Object.hasOwn(raw, 'toolCallId')) {
    const message = controlObject(value, ['role', 'content', 'toolCallId']);
    if (message.role !== TOOL_ROLE) return freeExecutionFail();
    return {
      role: TOOL_ROLE,
      content: text(message.content, inputBytes, true),
      toolCallId: toolId(message.toolCallId),
    };
  }
  if (Object.hasOwn(raw, 'toolCalls')) {
    const message = controlObject(value, ['role', 'content', 'toolCalls']);
    if (message.role !== FREE_CHAT_ROLES.ASSISTANT) return freeExecutionFail();
    return {
      role: FREE_CHAT_ROLES.ASSISTANT,
      content: text(message.content, inputBytes, true),
      toolCalls: parseToolCalls(message.toolCalls),
    };
  }
  const message = controlObject(value, ['role', 'content']);
  return {
    role: role(message.role),
    content: text(message.content, inputBytes),
  };
}
// The bytes a message adds to the input bound: its text and any tool JSON.
export function toolMessageBytes(message: ToolChatMessage): number {
  let total = bytes(message.content);
  if ('toolCalls' in message)
    for (const call of message.toolCalls)
      total += bytes(call.id) + bytes(call.name) + bytes(call.arguments);
  if ('toolCallId' in message) total += bytes(message.toolCallId);
  return total;
}
export function toolsBytes(tools: readonly ToolDefinition[] = []): number {
  return tools.reduce(
    (sum, tool) =>
      sum +
      bytes(tool.name) +
      bytes(tool.description ?? '') +
      bytes(tool.parameters),
    0,
  );
}
export const hasToolTurns = (messages: readonly ToolChatMessage[]) =>
  messages.some((message) => 'toolCalls' in message || 'toolCallId' in message);

// A conversation with tool turns: an optional system message, then a user turn; an assistant turn after
// each user turn or after the results of every call it made; each assistant call answered by exactly one
// result, in a run right after it; a user turn may follow the results (clients send results and text
// together); ending with the user's turn or with results. Text turns other than an assistant's call turn
// and tool results must have content.
export function isToolConversation(
  messages: readonly ToolChatMessage[],
): boolean {
  const turns =
    messages[0]?.role === FREE_CHAT_ROLES.SYSTEM ? messages.slice(1) : messages;
  if (!turns.length || turns[0]!.role !== FREE_CHAT_ROLES.USER) return false;
  let pending: Set<string> | undefined;
  let previous: ToolChatMessage | undefined;
  for (const turn of turns) {
    if (turn.role === TOOL_ROLE) {
      if (!pending?.delete(turn.toolCallId)) return false;
    } else {
      if (pending?.size) return false;
      pending = undefined;
      if (turn.role === FREE_CHAT_ROLES.USER) {
        if (previous?.role === FREE_CHAT_ROLES.USER) return false;
        if (!turn.content) return false;
      } else if (turn.role === FREE_CHAT_ROLES.ASSISTANT) {
        if (previous?.role === FREE_CHAT_ROLES.ASSISTANT) return false;
        if ('toolCalls' in turn)
          pending = new Set(turn.toolCalls.map((call) => call.id));
        else if (!turn.content) return false;
      } else return false;
    }
    previous = turn;
  }
  if (pending?.size) return false;
  return (
    previous?.role === FREE_CHAT_ROLES.USER || previous?.role === TOOL_ROLE
  );
}
// Input that asks for tools must name them, and a named choice must be one of them.
export function checkToolInput(input: ToolInput): void {
  if (input.toolChoice !== undefined && !input.tools)
    return freeExecutionFail();
  if (
    input.toolChoice &&
    typeof input.toolChoice === 'object' &&
    !input.tools!.some(
      (tool) => tool.name === (input.toolChoice as { name: string }).name,
    )
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.INVALID);
}

// Every message's text, for size statistics over the whole conversation rather than its first message.
export const conversationText = (messages: readonly { content: string }[]) =>
  messages.map((message) => message.content).join('');
// A turn that called tools completed normally; receipts and telemetry record it as stop until their
// schemas name tool calls.
export const recordedFinishReason = <Reason extends string>(
  reason: Reason | typeof TOOL_CALLS_DONE,
): Exclude<Reason, typeof TOOL_CALLS_DONE> | 'stop' =>
  reason === TOOL_CALLS_DONE
    ? 'stop'
    : (reason as Exclude<Reason, typeof TOOL_CALLS_DONE>);
