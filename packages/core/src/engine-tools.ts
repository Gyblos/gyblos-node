// The tool calls a provider streamed, assembled and checked the same way for every engine: each names an
// offered tool, has an id and a JSON object for its arguments. A malformed call is a frame failure, so
// provider text never reaches an error.
import {
  jsonObjectText,
  toolName,
  type ToolCall,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { FrameFailure } from './engine-failures';

export interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

export function finishedToolCalls(
  calls: readonly PartialToolCall[],
  tools: readonly ToolDefinition[] = [],
): ToolCall[] {
  try {
    return calls.map((call) => {
      const name = toolName(call.name);
      if (!call.id || !tools.some((tool) => tool.name === name))
        throw new FrameFailure();
      return {
        id: call.id,
        name,
        arguments: jsonObjectText(call.arguments || '{}'),
      };
    });
  } catch {
    throw new FrameFailure();
  }
}
