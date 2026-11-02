// Adapts the supported text-and-tool subset of Anthropic Messages to the local paid agent.
import { AGENT_CHAT } from '@gyblos/protocol/constants';

import { PAYPAL_AGENT_REQUEST_LIMITS } from './constants';
import {
  invalidAgentProtocol,
  protocolCache,
  protocolFields,
  protocolJsonObject,
  protocolObject,
  protocolText,
  protocolTextBlocks,
} from './paypal-agent-protocol-common';

function anthropicMessages(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxRows
  )
    return invalidAgentProtocol();
  const messages: Record<string, unknown>[] = [];
  const pendingCalls = new Set<string>();
  for (const [index, item] of value.entries()) {
    const message = protocolObject(item);
    protocolFields(message, ['role', 'content']);
    if (message.role === AGENT_CHAT.ROLES.SYSTEM) {
      const previous = index > 0 ? protocolObject(value[index - 1]) : null;
      const next =
        index + 1 < value.length ? protocolObject(value[index + 1]) : null;
      if (
        pendingCalls.size ||
        !previous ||
        (previous.role !== AGENT_CHAT.ROLES.USER &&
          previous.role !== AGENT_CHAT.ROLES.SYSTEM) ||
        (next &&
          next.role !== AGENT_CHAT.ROLES.SYSTEM &&
          next.role !== AGENT_CHAT.ROLES.ASSISTANT)
      )
        return invalidAgentProtocol();
      messages.push({
        role: AGENT_CHAT.ROLES.SYSTEM,
        content: protocolTextBlocks(message.content, ['text']),
      });
      continue;
    }
    if (
      message.role !== AGENT_CHAT.ROLES.USER &&
      message.role !== AGENT_CHAT.ROLES.ASSISTANT
    )
      return invalidAgentProtocol();
    if (pendingCalls.size && message.role !== AGENT_CHAT.ROLES.USER)
      return invalidAgentProtocol();
    if (typeof message.content === 'string') {
      if (pendingCalls.size) return invalidAgentProtocol();
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (
      !Array.isArray(message.content) ||
      !message.content.length ||
      message.content.length > PAYPAL_AGENT_REQUEST_LIMITS.maxRows
    )
      return invalidAgentProtocol();
    let text = '';
    let sawUserText = false;
    const calls: Record<string, unknown>[] = [];
    const flushUser = () => {
      if (text) messages.push({ role: AGENT_CHAT.ROLES.USER, content: text });
      text = '';
    };
    for (const entry of message.content) {
      const block = protocolObject(entry);
      if (block.type === 'text') {
        if (calls.length) return invalidAgentProtocol();
        if (message.role === AGENT_CHAT.ROLES.USER) {
          if (pendingCalls.size) return invalidAgentProtocol();
          sawUserText = true;
        }
        text += protocolTextBlocks([block], ['text']);
      } else if (
        block.type === 'tool_use' &&
        message.role === AGENT_CHAT.ROLES.ASSISTANT
      ) {
        protocolFields(block, ['type', 'id', 'name', 'input', 'cache_control']);
        if (block.cache_control !== undefined)
          protocolCache(block.cache_control);
        calls.push({
          id: protocolText(block.id),
          type: AGENT_CHAT.FUNCTION,
          function: {
            name: protocolText(block.name),
            arguments: JSON.stringify(protocolObject(block.input)),
          },
        });
      } else if (
        block.type === 'tool_result' &&
        message.role === AGENT_CHAT.ROLES.USER
      ) {
        if (sawUserText) return invalidAgentProtocol();
        protocolFields(block, [
          'type',
          'tool_use_id',
          'content',
          'is_error',
          'cache_control',
        ]);
        if (block.cache_control !== undefined)
          protocolCache(block.cache_control);
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean')
          return invalidAgentProtocol();
        const toolUseId = protocolText(block.tool_use_id);
        if (!pendingCalls.delete(toolUseId)) return invalidAgentProtocol();
        flushUser();
        const content =
          block.content === undefined
            ? ''
            : protocolTextBlocks(block.content, ['text']);
        messages.push({
          role: AGENT_CHAT.ROLES.TOOL,
          tool_call_id: toolUseId,
          content: block.is_error ? `Tool error: ${content}` : content,
        });
      } else return invalidAgentProtocol();
    }
    if (message.role === AGENT_CHAT.ROLES.ASSISTANT) {
      if (!text && !calls.length) return invalidAgentProtocol();
      for (const call of calls) {
        const id = protocolText(call.id);
        if (pendingCalls.has(id)) return invalidAgentProtocol();
        pendingCalls.add(id);
      }
      messages.push({
        role: AGENT_CHAT.ROLES.ASSISTANT,
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else {
      if (pendingCalls.size) return invalidAgentProtocol();
      flushUser();
    }
  }
  if (pendingCalls.size) return invalidAgentProtocol();
  return messages;
}
function anthropicTools(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxTools
  )
    return invalidAgentProtocol();
  return value.map((item) => {
    const tool = protocolObject(item);
    protocolFields(tool, [
      'name',
      'description',
      'input_schema',
      'cache_control',
    ]);
    if (tool.cache_control !== undefined) protocolCache(tool.cache_control);
    return {
      type: AGENT_CHAT.FUNCTION,
      function: {
        name: protocolText(tool.name),
        ...(tool.description !== undefined
          ? { description: protocolText(tool.description) }
          : {}),
        parameters: protocolObject(tool.input_schema),
      },
    };
  });
}
export function anthropicAgentRequest(value: unknown) {
  const row = protocolObject(value);
  protocolFields(row, [
    'model',
    'max_tokens',
    'system',
    'messages',
    'tools',
    'tool_choice',
    'stream',
    'temperature',
    'top_p',
    'metadata',
  ]);
  if (row.metadata !== undefined) {
    const metadata = protocolObject(row.metadata);
    protocolFields(metadata, ['user_id']);
    if (
      metadata.user_id !== undefined &&
      (typeof metadata.user_id !== 'string' || metadata.user_id.length > 256)
    )
      return invalidAgentProtocol();
  }
  const messages = anthropicMessages(row.messages);
  if (row.system !== undefined)
    messages.unshift({
      role: AGENT_CHAT.ROLES.SYSTEM,
      content: protocolTextBlocks(row.system, ['text']),
    });
  if (row.stream !== undefined && typeof row.stream !== 'boolean')
    return invalidAgentProtocol();
  let toolChoice: string | undefined;
  if (row.tool_choice !== undefined) {
    const choice = protocolObject(row.tool_choice);
    protocolFields(choice, ['type']);
    if (choice.type !== 'auto' && choice.type !== 'none')
      return invalidAgentProtocol();
    toolChoice = choice.type;
  }
  return {
    model: row.model,
    max_tokens: row.max_tokens,
    messages,
    ...(row.tools !== undefined ? { tools: anthropicTools(row.tools) } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(row.stream !== undefined ? { stream: row.stream } : {}),
    ...(row.temperature !== undefined ? { temperature: row.temperature } : {}),
    ...(row.top_p !== undefined ? { top_p: row.top_p } : {}),
  };
}
function anthropicOutput(result: Record<string, unknown>) {
  if (!Array.isArray(result.choices) || result.choices.length !== 1)
    return invalidAgentProtocol();
  const choice = protocolObject(result.choices[0]);
  const message = protocolObject(choice.message);
  const usage = protocolObject(result.usage);
  const content: Record<string, unknown>[] = [];
  if (typeof message.content === 'string' && message.content)
    content.push({ type: 'text', text: message.content });
  if (Array.isArray(message.tool_calls))
    for (const item of message.tool_calls) {
      const call = protocolObject(item);
      const fn = protocolObject(call.function);
      content.push({
        type: 'tool_use',
        id: call.id,
        name: fn.name,
        input: protocolJsonObject(fn.arguments),
      });
    }
  return {
    id: `msg_${protocolText(result.id)}`,
    type: 'message',
    role: AGENT_CHAT.ROLES.ASSISTANT,
    content,
    model: result.model,
    stop_reason:
      choice.finish_reason === AGENT_CHAT.FINISH.TOOL_CALLS
        ? 'tool_use'
        : choice.finish_reason === AGENT_CHAT.FINISH.LENGTH
          ? 'max_tokens'
          : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
    },
  };
}
function event(type: string, value: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}
export function anthropicAgentResponse(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const output = anthropicOutput(result);
  if (input.stream !== true)
    return Response.json(output, { headers: { 'cache-control': 'no-store' } });
  let stream = event('message_start', {
    message: {
      ...output,
      content: [],
      stop_reason: null,
      usage: { ...output.usage, output_tokens: 0 },
    },
  });
  for (const [index, block] of output.content.entries()) {
    if (block.type === 'text') {
      stream += event('content_block_start', {
        index,
        content_block: { type: 'text', text: '' },
      });
      stream += event('content_block_delta', {
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      stream += event('content_block_start', {
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      stream += event('content_block_delta', {
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      });
    }
    stream += event('content_block_stop', { index });
  }
  stream += event('message_delta', {
    delta: { stop_reason: output.stop_reason, stop_sequence: null },
    usage: { output_tokens: output.usage.output_tokens },
  });
  stream += event('message_stop', {});
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    },
  });
}
