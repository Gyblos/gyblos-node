// Tool calling over the Anthropic Messages API: turns with tool_use and tool_result blocks, the tools and
// tool choice in the API's shape, and the streamed tool_use blocks assembled into calls.
import { FrameFailure } from '@gyblos/core/engine-failures';
import { isJsonFields } from '@gyblos/core/engine-provider';
import type { PartialToolCall } from '@gyblos/core/engine-tools';
import {
  TOOL_CHOICES,
  TOOL_ROLE,
  type ToolChatMessage,
  type ToolChoice,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

export const ANTHROPIC_TOOL_USE = 'tool_use';
export const ANTHROPIC_INPUT_DELTA = 'input_json_delta';

// The turns after the system message; a run of tool results is one user turn of tool_result blocks.
export function anthropicTurns(messages: readonly ToolChatMessage[]) {
  const turns: { role: string; content: unknown }[] = [];
  for (const message of messages) {
    if (message.role === TOOL_ROLE) {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      const last = turns.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content))
        last.content.push(block);
      else turns.push({ role: 'user', content: [block] });
    } else if ('toolCalls' in message)
      turns.push({
        role: message.role,
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: ANTHROPIC_TOOL_USE,
            id: call.id,
            name: call.name,
            input: JSON.parse(call.arguments) as unknown,
          })),
        ],
      });
    else turns.push({ role: message.role, content: message.content });
  }
  return turns;
}

const CHOICES: Readonly<Record<string, string>> = {
  [TOOL_CHOICES.AUTO]: 'auto',
  [TOOL_CHOICES.REQUIRED]: 'any',
  [TOOL_CHOICES.NONE]: 'none',
};

// The request fields that offer tools; none when the input offers none.
export function anthropicTools(
  tools: readonly ToolDefinition[] | undefined,
  choice: ToolChoice | undefined,
) {
  if (!tools?.length) return {};
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      input_schema: JSON.parse(tool.parameters) as unknown,
    })),
    ...(choice === undefined
      ? {}
      : {
          tool_choice:
            typeof choice === 'object'
              ? { type: 'tool', name: choice.name }
              : { type: CHOICES[choice] },
        }),
  };
}

// A content block that opens a tool call, recorded at its index.
export function startToolBlock(
  index: unknown,
  block: unknown,
  calls: (PartialToolCall | undefined)[],
) {
  if (!isJsonFields(block) || block.type !== ANTHROPIC_TOOL_USE) return;
  if (
    !Number.isSafeInteger(index) ||
    typeof block.id !== 'string' ||
    typeof block.name !== 'string'
  )
    throw new FrameFailure();
  calls[index as number] = { id: block.id, name: block.name, arguments: '' };
}

// A fragment of a tool call's input JSON, appended to the call its block opened.
export function toolInputDelta(
  index: unknown,
  partial: unknown,
  calls: (PartialToolCall | undefined)[],
) {
  const call = Number.isSafeInteger(index) ? calls[index as number] : undefined;
  if (!call || typeof partial !== 'string') throw new FrameFailure();
  call.arguments += partial;
}
