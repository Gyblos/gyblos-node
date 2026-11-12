// Tool calling over OpenAI-compatible chat completions: the request's messages, tools and tool choice in the
// provider's shape, and the streamed tool_call deltas assembled into whole calls. Provider text never
// reaches errors: a malformed call is a frame failure.
import { FrameFailure } from '@gyblos/core/engine-failures';
import { isJsonFields, type JsonFields } from '@gyblos/core/engine-provider';
import type { PartialToolCall } from '@gyblos/core/engine-tools';
import {
  TOOL_ROLE,
  type ToolChatMessage,
  type ToolChoice,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

export function openAiMessages(messages: readonly ToolChatMessage[]) {
  return messages.map((message) => {
    if (message.role === TOOL_ROLE)
      return {
        role: TOOL_ROLE,
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    if ('toolCalls' in message)
      return {
        role: message.role,
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    return { role: message.role, content: message.content };
  });
}

// The request fields that offer tools; none when the input offers none.
export function openAiTools(
  tools: readonly ToolDefinition[] | undefined,
  choice: ToolChoice | undefined,
) {
  if (!tools?.length) return {};
  return {
    tools: tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        parameters: JSON.parse(tool.parameters) as unknown,
      },
    })),
    ...(choice === undefined
      ? {}
      : {
          tool_choice:
            typeof choice === 'object'
              ? { type: 'function', function: { name: choice.name } }
              : choice,
        }),
  };
}

// Adds one delta's tool_calls fragments to the calls being written, by index.
export function applyToolDeltas(value: unknown, calls: PartialToolCall[]) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new FrameFailure();
  for (const entry of value) {
    if (!isJsonFields(entry) || !Number.isSafeInteger(entry.index))
      throw new FrameFailure();
    const index = entry.index as number;
    if (index < 0 || index > calls.length) throw new FrameFailure();
    const call = (calls[index] ??= { id: '', name: '', arguments: '' });
    const fn: JsonFields = isJsonFields(entry.function) ? entry.function : {};
    if (typeof entry.id === 'string') call.id += entry.id;
    if (typeof fn.name === 'string') call.name += fn.name;
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
  }
}
