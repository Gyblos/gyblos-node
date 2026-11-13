// Reconstructs the local Anthropic stream by block index; no call is valid before its own stop and terminal.
import { isJsonFields, type JsonFields } from '@gyblos/core/engine-provider';

import { acceptanceAssert } from './errors';

interface Block {
  index: number;
  value: JsonFields;
  text: string;
  arguments: string;
}
export function anthropicToolBlocks(events: JsonFields[]) {
  acceptanceAssert(events[0]?.type === 'message_start');
  const blocks: JsonFields[] = [];
  let current: Block | undefined;
  let terminal = false;
  for (const [position, event] of events.entries()) {
    if (position === 0) continue;
    if (event.type === 'content_block_start') {
      acceptanceAssert(
        !terminal &&
          !current &&
          event.index === blocks.length &&
          isJsonFields(event.content_block),
      );
      const value = event.content_block;
      acceptanceAssert(value.type === 'text' || value.type === 'tool_use');
      if (value.type === 'text')
        acceptanceAssert(typeof value.text === 'string');
      else
        acceptanceAssert(
          isJsonFields(value.input) && Object.keys(value.input).length === 0,
        );
      current = {
        index: blocks.length,
        value,
        text: value.type === 'text' ? String(value.text) : '',
        arguments: '',
      };
    } else if (event.type === 'content_block_delta') {
      acceptanceAssert(
        !terminal &&
          current &&
          event.index === current.index &&
          isJsonFields(event.delta),
      );
      if (current.value.type === 'tool_use') {
        acceptanceAssert(
          event.delta.type === 'input_json_delta' &&
            typeof event.delta.partial_json === 'string',
        );
        current.arguments += event.delta.partial_json;
      } else {
        acceptanceAssert(
          event.delta.type === 'text_delta' &&
            typeof event.delta.text === 'string',
        );
        current.text += event.delta.text;
      }
    } else if (event.type === 'content_block_stop') {
      acceptanceAssert(!terminal && current && event.index === current.index);
      if (current.value.type === 'tool_use') {
        const input: unknown = JSON.parse(current.arguments);
        acceptanceAssert(isJsonFields(input));
        blocks.push({ ...current.value, input });
      } else blocks.push({ ...current.value, text: current.text });
      current = undefined;
    } else if (event.type === 'message_delta') {
      acceptanceAssert(
        !terminal &&
          !current &&
          blocks.length > 0 &&
          position === events.length - 2,
      );
      terminal = true;
    } else {
      acceptanceAssert(
        event.type === 'message_stop' &&
          terminal &&
          !current &&
          position === events.length - 1,
      );
    }
  }
  acceptanceAssert(
    terminal && events.at(-1)?.type === 'message_stop' && !current,
  );
  return blocks;
}
