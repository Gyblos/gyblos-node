// Translates the bounded agent contract to Ollama's native, non-truncating chat API.
import { randomUUID } from 'node:crypto';

import { SANDBOX_AGENT_LIMITS, UNITS } from '@gyblos/config';
import { isJsonFields } from '@gyblos/core/engine-provider';
import { AGENT_CHAT } from '@gyblos/protocol/constants';

import { checkToolSchema, matchesToolSchema } from './agent-schema';

function invalid(): never {
  throw new Error('Unsupported agent request.');
}
function row(value: unknown): Record<string, unknown> {
  if (!isJsonFields(value)) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return value;
}
function calls(value: unknown, names: Map<string, string>) {
  if (!Array.isArray(value)) return invalid();
  return value.map((entry) => {
    const call = row(entry);
    const fn = row(call.function);
    const id = text(call.id);
    const name = text(fn.name);
    const argumentsValue: unknown = JSON.parse(text(fn.arguments));
    if (!id || !name || names.has(id) || !isJsonFields(argumentsValue))
      return invalid();
    names.set(id, name);
    return { id, function: { name, arguments: argumentsValue } };
  });
}
function messages(value: unknown) {
  if (!Array.isArray(value)) return invalid();
  const names = new Map<string, string>();
  const answered = new Set<string>();
  return value.map((entry) => {
    const message = row(entry);
    const role = text(message.role);
    if (message.name !== undefined || role === AGENT_CHAT.ROLES.DEVELOPER)
      return invalid();
    if (role === AGENT_CHAT.ROLES.ASSISTANT && message.tool_calls !== undefined)
      return {
        role,
        content:
          message.content === null || message.content === undefined
            ? ''
            : text(message.content),
        tool_calls: calls(message.tool_calls, names),
      };
    if (role === AGENT_CHAT.ROLES.TOOL) {
      const id = text(message.tool_call_id);
      const toolName = names.get(id);
      if (!toolName || answered.has(id)) return invalid();
      answered.add(id);
      return {
        role,
        content: text(message.content),
        tool_name: toolName,
        tool_call_id: id,
      };
    }
    return { role, content: text(message.content) };
  });
}
function tools(value: unknown) {
  if (!Array.isArray(value)) return invalid();
  return value.map((entry) => {
    const tool = row(entry);
    const fn = row(tool.function);
    if (fn.strict === true) return invalid();
    if (fn.parameters !== undefined) checkToolSchema(fn.parameters);
    const { strict: _strict, ...remaining } = fn;
    return { type: tool.type, function: remaining };
  });
}

export function ollamaAgentRequest(input: unknown, model: string) {
  const value = row(input);
  if (
    value.model !== model ||
    value.remote_host ||
    value.remote_model ||
    typeof value.max_tokens !== 'number' ||
    !Number.isSafeInteger(value.max_tokens) ||
    value.max_tokens < 1 ||
    value.max_tokens > SANDBOX_AGENT_LIMITS.maxOutputTokens ||
    value.tool_choice === 'required' ||
    value.parallel_tool_calls === false
  )
    return invalid();
  return {
    model,
    messages: messages(value.messages),
    ...(value.tools !== undefined && value.tool_choice !== 'none'
      ? { tools: tools(value.tools) }
      : {}),
    stream: false,
    truncate: false,
    shift: false,
    options: {
      num_ctx: SANDBOX_AGENT_LIMITS.contextTokens,
      num_predict: value.max_tokens,
      ...(value.temperature !== undefined
        ? { temperature: value.temperature }
        : {}),
      ...(value.top_p !== undefined ? { top_p: value.top_p } : {}),
    },
  };
}

function responseToolCalls(
  value: Record<string, unknown>,
  message: Record<string, unknown>,
  request: unknown,
) {
  if (message.tool_calls === undefined) return undefined;
  const inputRequest = row(request);
  if (
    value.done_reason !== 'stop' ||
    inputRequest.tool_choice === 'none' ||
    !Array.isArray(message.tool_calls) ||
    message.tool_calls.length === 0
  )
    return invalid();
  return message.tool_calls.map((entry) => {
    const call = row(entry);
    const fn = row(call.function);
    const name = text(fn.name);
    const args = row(fn.arguments);
    if (!Array.isArray(inputRequest.tools)) return invalid();
    const tool = inputRequest.tools.find((item) => {
      const candidate = row(item);
      return row(candidate.function).name === name;
    });
    if (tool === undefined) return invalid();
    const parameters = row(row(tool).function).parameters;
    if (parameters !== undefined && !matchesToolSchema(parameters, args))
      return invalid();
    const id = call.id === undefined ? `call_${randomUUID()}` : text(call.id);
    if (!name || !id) return invalid();
    return {
      id,
      type: AGENT_CHAT.FUNCTION,
      function: { name, arguments: JSON.stringify(args) },
    };
  });
}

export function ollamaAgentResponse(
  input: unknown,
  model: string,
  request: unknown,
) {
  const value = row(input);
  const message = row(value.message);
  const created = Date.parse(text(value.created_at));
  if (
    value.model !== model ||
    value.remote_host ||
    value.remote_model ||
    value.done !== true ||
    !Number.isFinite(created) ||
    message.role !== AGENT_CHAT.ROLES.ASSISTANT ||
    typeof message.content !== 'string' ||
    (value.done_reason !== 'stop' && value.done_reason !== 'length') ||
    typeof value.prompt_eval_count !== 'number' ||
    typeof value.eval_count !== 'number'
  )
    return invalid();
  const toolCalls = responseToolCalls(value, message, request);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: AGENT_CHAT.COMPLETION,
    created: Math.floor(created / UNITS.millisecondsPerSecond),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: AGENT_CHAT.ROLES.ASSISTANT,
          content: toolCalls && !message.content ? null : message.content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls
          ? AGENT_CHAT.FINISH.TOOL_CALLS
          : value.done_reason,
      },
    ],
    usage: {
      prompt_tokens: value.prompt_eval_count,
      completion_tokens: value.eval_count,
      total_tokens: value.prompt_eval_count + value.eval_count,
    },
  };
}
