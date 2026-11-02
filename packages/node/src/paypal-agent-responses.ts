// Adapts the supported text-and-function subset of OpenAI Responses to the local paid agent.
import { SANDBOX_AGENT_LIMITS } from '@gyblos/config/limits';
import { AGENT_CHAT } from '@gyblos/protocol/constants';

import { PAYPAL_AGENT_REQUEST_LIMITS } from './constants';
import {
  invalidAgentProtocol,
  protocolFields,
  protocolObject,
  protocolText,
  protocolTextBlocks,
} from './paypal-agent-protocol-common';

function responsesMessages(value: unknown) {
  const messages: Record<string, unknown>[] = [];
  if (typeof value === 'string')
    return [{ role: AGENT_CHAT.ROLES.USER, content: value }];
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxRows
  )
    return invalidAgentProtocol();
  for (const item of value) {
    const row = protocolObject(item);
    if (row.type === 'function_call') {
      protocolFields(row, [
        'type',
        'id',
        'call_id',
        'name',
        'arguments',
        'status',
      ]);
      const call = {
        id: protocolText(row.call_id),
        type: AGENT_CHAT.FUNCTION,
        function: {
          name: protocolText(row.name),
          arguments: protocolText(row.arguments),
        },
      };
      const previous = messages.at(-1);
      if (
        previous?.role === AGENT_CHAT.ROLES.ASSISTANT &&
        Array.isArray(previous.tool_calls)
      )
        previous.tool_calls.push(call);
      else
        messages.push({
          role: AGENT_CHAT.ROLES.ASSISTANT,
          content: null,
          tool_calls: [call],
        });
    } else if (row.type === 'function_call_output') {
      protocolFields(row, ['type', 'id', 'call_id', 'output', 'status']);
      messages.push({
        role: AGENT_CHAT.ROLES.TOOL,
        tool_call_id: protocolText(row.call_id),
        content: protocolText(row.output),
      });
    } else {
      protocolFields(row, ['type', 'role', 'content', 'id', 'status']);
      if (row.type !== undefined && row.type !== 'message')
        return invalidAgentProtocol();
      if (
        ![
          AGENT_CHAT.ROLES.SYSTEM,
          AGENT_CHAT.ROLES.DEVELOPER,
          AGENT_CHAT.ROLES.USER,
          AGENT_CHAT.ROLES.ASSISTANT,
        ].some((role) => role === row.role)
      )
        return invalidAgentProtocol();
      messages.push({
        role:
          row.role === AGENT_CHAT.ROLES.DEVELOPER
            ? AGENT_CHAT.ROLES.SYSTEM
            : row.role,
        content: protocolTextBlocks(row.content, [
          'input_text',
          'output_text',
          'text',
        ]),
      });
    }
  }
  return messages;
}
function responsesTools(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > PAYPAL_AGENT_REQUEST_LIMITS.maxTools
  )
    return invalidAgentProtocol();
  return value.map((item) => {
    const tool = protocolObject(item);
    protocolFields(tool, [
      'type',
      'name',
      'description',
      'parameters',
      'strict',
    ]);
    if (
      tool.type !== AGENT_CHAT.FUNCTION ||
      (tool.strict !== undefined && tool.strict !== false)
    )
      return invalidAgentProtocol();
    return {
      type: AGENT_CHAT.FUNCTION,
      function: {
        name: protocolText(tool.name),
        ...(tool.description !== undefined
          ? { description: protocolText(tool.description) }
          : {}),
        parameters: protocolObject(tool.parameters),
      },
    };
  });
}
export function responsesAgentRequest(value: unknown) {
  const row = protocolObject(value);
  protocolFields(row, [
    'model',
    'input',
    'instructions',
    'tools',
    'tool_choice',
    'stream',
    'store',
    'max_output_tokens',
    'temperature',
    'top_p',
    'parallel_tool_calls',
    'reasoning',
    'include',
    'prompt_cache_key',
    'client_metadata',
  ]);
  if (row.store !== undefined && row.store !== false)
    return invalidAgentProtocol();
  if (row.stream !== undefined && typeof row.stream !== 'boolean')
    return invalidAgentProtocol();
  if (row.parallel_tool_calls !== undefined && row.parallel_tool_calls !== true)
    return invalidAgentProtocol();
  if (
    row.prompt_cache_key !== undefined &&
    (typeof row.prompt_cache_key !== 'string' ||
      row.prompt_cache_key.length >
        PAYPAL_AGENT_REQUEST_LIMITS.protocolIdentifierCharacters)
  )
    return invalidAgentProtocol();
  if (row.client_metadata !== undefined) {
    const metadata = protocolObject(row.client_metadata);
    if (
      Object.keys(metadata).length >
        PAYPAL_AGENT_REQUEST_LIMITS.metadataEntries ||
      Object.entries(metadata).some(
        ([key, value]) =>
          key.length > PAYPAL_AGENT_REQUEST_LIMITS.metadataKeyCharacters ||
          typeof value !== 'string' ||
          value.length > PAYPAL_AGENT_REQUEST_LIMITS.metadataValueCharacters,
      )
    )
      return invalidAgentProtocol();
  }
  if (row.reasoning !== undefined) {
    const reasoning = protocolObject(row.reasoning);
    protocolFields(reasoning, ['summary']);
    if (reasoning.summary !== undefined && reasoning.summary !== 'auto')
      return invalidAgentProtocol();
  }
  if (
    row.include !== undefined &&
    (!Array.isArray(row.include) ||
      row.include.some((entry) => entry !== 'reasoning.encrypted_content'))
  )
    return invalidAgentProtocol();
  const messages = responsesMessages(row.input);
  if (row.instructions !== undefined)
    messages.unshift({
      role: AGENT_CHAT.ROLES.SYSTEM,
      content: protocolText(row.instructions),
    });
  return {
    model: row.model,
    messages,
    max_tokens: row.max_output_tokens ?? SANDBOX_AGENT_LIMITS.maxOutputTokens,
    ...(row.tools !== undefined ? { tools: responsesTools(row.tools) } : {}),
    ...(row.tool_choice !== undefined ? { tool_choice: row.tool_choice } : {}),
    ...(row.stream !== undefined ? { stream: row.stream } : {}),
    ...(row.temperature !== undefined ? { temperature: row.temperature } : {}),
    ...(row.top_p !== undefined ? { top_p: row.top_p } : {}),
  };
}
function responsesOutput(result: Record<string, unknown>) {
  if (!Array.isArray(result.choices) || result.choices.length !== 1)
    return invalidAgentProtocol();
  const choice = protocolObject(result.choices[0]);
  const message = protocolObject(choice.message);
  const incomplete = choice.finish_reason === AGENT_CHAT.FINISH.LENGTH;
  const output: Record<string, unknown>[] = [];
  if (typeof message.content === 'string' && message.content)
    output.push({
      id: `msg_${protocolText(result.id)}`,
      type: 'message',
      status: incomplete ? 'incomplete' : 'completed',
      role: AGENT_CHAT.ROLES.ASSISTANT,
      content: [
        { type: 'output_text', text: message.content, annotations: [] },
      ],
    });
  if (Array.isArray(message.tool_calls))
    for (const item of message.tool_calls) {
      const call = protocolObject(item);
      const fn = protocolObject(call.function);
      output.push({
        id: `fc_${protocolText(call.id)}`,
        type: 'function_call',
        status: 'completed',
        call_id: call.id,
        name: fn.name,
        arguments: fn.arguments,
      });
    }
  return {
    id: `resp_${protocolText(result.id)}`,
    object: 'response',
    created_at: result.created,
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    model: result.model,
    output,
    // Ollama does not provide the cache and reasoning breakdown required by Responses.
    usage: null,
  };
}
function event(type: string, value: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}
function responsesStreamItem(
  item: Record<string, unknown>,
  index: number,
  emit: (type: string, value: Record<string, unknown>) => string,
) {
  let stream = '';
  stream += emit('response.output_item.added', {
    output_index: index,
    item:
      item.type === 'function_call'
        ? { ...item, status: 'in_progress', arguments: '' }
        : { ...item, status: 'in_progress', content: [] },
  });
  if (item.type === 'function_call') {
    stream += emit('response.function_call_arguments.delta', {
      item_id: item.id,
      output_index: index,
      delta: item.arguments,
    });
    stream += emit('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: index,
      arguments: item.arguments,
    });
  } else {
    const part = Array.isArray(item.content)
      ? protocolObject(item.content[0])
      : invalidAgentProtocol();
    stream += emit('response.content_part.added', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    stream += emit('response.output_text.delta', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: part.text,
    });
    stream += emit('response.output_text.done', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      text: part.text,
    });
    stream += emit('response.content_part.done', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part,
    });
  }
  stream += emit('response.output_item.done', { output_index: index, item });
  return stream;
}
export function responsesAgentResponse(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const output = responsesOutput(result);
  if (input.stream !== true)
    return Response.json(output, { headers: { 'cache-control': 'no-store' } });
  let sequence = 0;
  const emit = (type: string, value: Record<string, unknown>) =>
    event(type, { sequence_number: sequence++, ...value });
  let stream = emit('response.created', {
    response: {
      ...output,
      status: 'in_progress',
      incomplete_details: null,
      output: [],
    },
  });
  stream += emit('response.in_progress', {
    response: {
      ...output,
      status: 'in_progress',
      incomplete_details: null,
      output: [],
    },
  });
  for (const [index, item] of output.output.entries())
    stream += responsesStreamItem(item, index, emit);
  stream += emit(
    output.status === 'completed'
      ? 'response.completed'
      : 'response.incomplete',
    { response: output },
  );
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    },
  });
}
