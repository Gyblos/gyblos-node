// Tool calling over the Anthropic Messages API: turns with tool_use and tool_result blocks, the tools and
// tool choice in the API's shape, and the streamed tool_use blocks assembled into calls.
import { FrameFailure } from '@gyblos/core/engine-failures';
import { isJsonFields } from '@gyblos/core/engine-provider';
import type { PartialToolCall } from '@gyblos/core/engine-tools';
import {
  TOOL_CHOICES,
  TOOL_LIMITS,
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
    else {
      const last = turns.at(-1);
      // Text after results joins their user turn, as clients send them.
      if (
        message.role === 'user' &&
        last?.role === 'user' &&
        Array.isArray(last.content)
      )
        last.content.push({ type: 'text', text: message.content });
      else turns.push({ role: message.role, content: message.content });
    }
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

// The calls being written, by content block index. Text and thinking blocks take indexes too, so an answer
// with the most calls a turn allows still fits well below this bound; any index beyond it, or more calls
// than a turn allows, is a malformed stream, refused before anything is stored.
// Room for a text or thinking block around every call, twice over.
const BLOCKS_PER_CALL = 4;
export const MAX_CONTENT_BLOCKS = BLOCKS_PER_CALL * TOOL_LIMITS.maxCallsPerTurn;
export type ToolBlocks = Map<number, PartialToolCall>;

function blockIndex(index: unknown): number {
  if (
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    (index as number) >= MAX_CONTENT_BLOCKS
  )
    throw new FrameFailure();
  return index as number;
}

// A content block that opens a tool call, recorded at its index.
export function startToolBlock(
  index: unknown,
  block: unknown,
  calls: ToolBlocks,
) {
  if (!isJsonFields(block) || block.type !== ANTHROPIC_TOOL_USE) return;
  const at = blockIndex(index);
  if (
    calls.has(at) ||
    calls.size >= TOOL_LIMITS.maxCallsPerTurn ||
    typeof block.id !== 'string' ||
    typeof block.name !== 'string'
  )
    throw new FrameFailure();
  calls.set(at, { id: block.id, name: block.name, arguments: '' });
}

// A fragment of a tool call's input JSON, appended to the call its block opened.
export function toolInputDelta(
  index: unknown,
  partial: unknown,
  calls: ToolBlocks,
) {
  const call = calls.get(blockIndex(index));
  if (!call || typeof partial !== 'string') throw new FrameFailure();
  call.arguments += partial;
}

// The calls in block order.
export const orderedCalls = (calls: ToolBlocks) =>
  [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
