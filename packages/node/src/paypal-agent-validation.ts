// Validates the sandbox agent's bounded OpenAI-compatible request and completed result.
// This is a local prototype contract, not the network execution wire.
import { createHash } from 'node:crypto';

import { AGENT_CHAT, PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_AGENT_REQUEST_LIMITS,
  PAYPAL_REQUEST_LIMITS,
} from './constants';

const REQUEST_FIELDS = [
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'parallel_tool_calls',
  'n',
] as const;
const MAX_NAME = 128;

function invalid(): never {
  throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
}
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return Object.fromEntries(Object.entries(value));
}
function allowed(row: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(row).some((key) => !names.includes(key))) invalid();
}
function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_NAME)
    return invalid();
  return value;
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    return invalid();
  return value;
}
function toolCalls(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxTools
  )
    return invalid();
  const ids = new Set<string>();
  for (const item of value) {
    const call = fields(item);
    allowed(call, ['id', 'type', 'function']);
    const id = name(call.id);
    if (ids.has(id)) invalid();
    ids.add(id);
    if (call.type !== AGENT_CHAT.FUNCTION) invalid();
    const fn = fields(call.function);
    allowed(fn, ['name', 'arguments']);
    name(fn.name);
    if (typeof fn.arguments !== 'string') invalid();
    try {
      fields(JSON.parse(fn.arguments));
    } catch {
      invalid();
    }
  }
}
function textContent(value: unknown) {
  if (typeof value === 'string') return value;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxRows
  )
    return invalid();
  return value
    .map((item) => {
      const block = fields(item);
      allowed(block, ['type', 'text']);
      if (block.type !== 'text' || typeof block.text !== 'string')
        return invalid();
      return block.text;
    })
    .join('');
}
function message(value: unknown) {
  const row = fields(value);
  const { ROLES } = AGENT_CHAT;
  if (
    row.role === ROLES.SYSTEM ||
    row.role === ROLES.DEVELOPER ||
    row.role === ROLES.USER
  ) {
    allowed(row, ['role', 'content', 'name']);
    if (row.name !== undefined) name(row.name);
    return { ...row, content: textContent(row.content) };
  }
  if (row.role === ROLES.TOOL) {
    allowed(row, ['role', 'content', 'tool_call_id']);
    if (typeof row.content !== 'string') invalid();
    name(row.tool_call_id);
    return row;
  }
  if (row.role === ROLES.ASSISTANT) {
    allowed(row, ['role', 'content', 'tool_calls', 'name']);
    if (
      row.content !== null &&
      row.content !== undefined &&
      typeof row.content !== 'string'
    )
      invalid();
    if (row.name !== undefined) name(row.name);
    if (row.tool_calls !== undefined) toolCalls(row.tool_calls);
    if (
      (row.content === null || row.content === undefined) &&
      row.tool_calls === undefined
    )
      invalid();
    return row;
  }
  invalid();
}
function tools(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxTools
  )
    return invalid();
  for (const item of value) {
    const tool = fields(item);
    allowed(tool, ['type', 'function']);
    if (tool.type !== AGENT_CHAT.FUNCTION) invalid();
    const fn = fields(tool.function);
    allowed(fn, ['name', 'description', 'parameters', 'strict']);
    name(fn.name);
    if (fn.description !== undefined && typeof fn.description !== 'string')
      invalid();
    if (fn.parameters !== undefined) fields(fn.parameters);
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') invalid();
  }
}
function optionalNumber(value: unknown, min: number, max: number) {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max)
  )
    invalid();
}

export function validatePaypalAgentRequest(
  input: unknown,
  model: string,
): Record<string, unknown> {
  const row = fields(input);
  allowed(row, REQUEST_FIELDS);
  if (name(row.model) !== model) invalid();
  if (
    !Array.isArray(row.messages) ||
    !row.messages.length ||
    row.messages.length > PAYPAL_AGENT_REQUEST_LIMITS.maxRows
  )
    invalid();
  const messages = row.messages.map(message);
  if (row.tools !== undefined) tools(row.tools);
  if (row.stream !== undefined && typeof row.stream !== 'boolean') invalid();
  if (
    row.parallel_tool_calls !== undefined &&
    typeof row.parallel_tool_calls !== 'boolean'
  )
    invalid();
  if (row.stream_options !== undefined) {
    const options = fields(row.stream_options);
    allowed(options, ['include_usage']);
    if (typeof options.include_usage !== 'boolean') invalid();
  }
  if (
    row.tool_choice !== undefined &&
    !['auto', 'none', 'required'].includes(String(row.tool_choice))
  )
    invalid();
  if (row.n !== undefined && row.n !== 1) invalid();
  optionalNumber(row.temperature, 0, 2);
  optionalNumber(row.top_p, 0, 1);
  if (row.max_tokens !== undefined && row.max_completion_tokens !== undefined)
    invalid();
  const maximum =
    row.max_tokens ??
    row.max_completion_tokens ??
    PAYPAL_REQUEST_LIMITS.maxTokens;
  if (count(maximum, PAYPAL_AGENT_REQUEST_LIMITS.maxTokens) < 1) invalid();
  const { max_completion_tokens: _maxCompletionTokens, ...remaining } = row;
  return { ...remaining, messages, max_tokens: maximum };
}

export function validatePaypalAgentResult(
  input: unknown,
  model: string,
  maxTokens: number,
  request: Record<string, unknown>,
) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return invalid();
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, 'utf8') >
      PAYPAL_AGENT_REQUEST_LIMITS.responseBytes
  )
    return invalid();
  const row = fields(JSON.parse(serialized));
  if (row.object !== AGENT_CHAT.COMPLETION || row.model !== model) invalid();
  name(row.id);
  count(row.created);
  if (!Array.isArray(row.choices) || row.choices.length !== 1) invalid();
  const choice = fields(row.choices[0]);
  if (choice.index !== 0) invalid();
  const answer = fields(choice.message);
  if (answer.role !== AGENT_CHAT.ROLES.ASSISTANT) invalid();
  message(answer);
  if (
    typeof answer.content === 'string' &&
    !answer.content.trim() &&
    answer.tool_calls === undefined
  )
    invalid();
  if (
    !Object.values(AGENT_CHAT.FINISH).some(
      (value) => value === choice.finish_reason,
    )
  )
    invalid();
  if (
    choice.finish_reason === AGENT_CHAT.FINISH.TOOL_CALLS &&
    answer.tool_calls === undefined
  )
    invalid();
  if (
    choice.finish_reason !== AGENT_CHAT.FINISH.TOOL_CALLS &&
    answer.tool_calls !== undefined
  )
    invalid();
  if (answer.tool_calls !== undefined) {
    const declared = new Set<string>();
    const previousIds = new Set<string>();
    if (Array.isArray(request.messages))
      for (const entry of request.messages) {
        const previous = fields(entry);
        if (Array.isArray(previous.tool_calls))
          for (const call of previous.tool_calls)
            previousIds.add(name(fields(call).id));
      }
    if (Array.isArray(request.tools))
      for (const item of request.tools)
        declared.add(name(fields(fields(item).function).name));
    if (!Array.isArray(answer.tool_calls)) invalid();
    for (const item of answer.tool_calls) {
      const call = fields(item);
      if (previousIds.has(name(call.id))) invalid();
      const fn = fields(call.function);
      if (!declared.has(name(fn.name))) invalid();
    }
  }
  const usage = fields(row.usage);
  const prompt = count(usage.prompt_tokens);
  const completion = count(usage.completion_tokens, maxTokens);
  if (count(usage.total_tokens) !== prompt + completion) invalid();
  return row;
}

function stableJson(value: unknown) {
  const text = JSON.stringify(value, (_key: string, entry: unknown) => {
    if (typeof entry === 'number' && !Number.isFinite(entry)) invalid();
    if (entry && typeof entry === 'object' && !Array.isArray(entry))
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    return entry;
  });
  if (text === undefined) return invalid();
  return text;
}
function digestMessages(value: unknown) {
  if (!Array.isArray(value)) return invalid();
  return value.map((item: unknown) => {
    const row = fields(item);
    if (
      row.role !== AGENT_CHAT.ROLES.ASSISTANT ||
      !Array.isArray(row.tool_calls)
    )
      return row;
    return {
      ...row,
      tool_calls: row.tool_calls.map((entry: unknown) => {
        const call = fields(entry);
        const fn = fields(call.function);
        if (typeof fn.arguments !== 'string') return invalid();
        const args: unknown = JSON.parse(fn.arguments);
        return { ...call, function: { ...fn, arguments: stableJson(args) } };
      }),
    };
  });
}
export function preparePaypalAgentRequest(input: unknown, model: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return invalid();
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, 'utf8') >
      PAYPAL_AGENT_REQUEST_LIMITS.requestBytes
  )
    return invalid();
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const normalized = validatePaypalAgentRequest(value, model);
  const {
    stream: _stream,
    stream_options: _streamOptions,
    ...inference
  } = normalized;
  const normalizedBytes = stableJson({
    ...inference,
    messages: digestMessages(inference.messages),
  });
  return {
    input: normalized,
    digest: createHash('sha256')
      .update(PAYPAL_AGENT_REQUEST_LIMITS.digestDomain)
      .update(normalizedBytes)
      .digest('hex'),
  };
}
export function paypalAgentIdempotencyDigest(key: string | undefined) {
  if (key === undefined) return undefined;
  if (
    key.length > PAYPAL_AGENT_REQUEST_LIMITS.idempotencyKeyCharacters ||
    !/^[A-Za-z0-9._~-]+$/.test(key)
  )
    return invalid();
  return createHash('sha256')
    .update(PAYPAL_AGENT_REQUEST_LIMITS.idempotencyDigestDomain)
    .update(key)
    .digest('hex');
}
