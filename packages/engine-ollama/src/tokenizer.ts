// Builds the recount tokenizer from hash-checked public tokenizer files; counts output and templated input,
// a lone prompt or a whole conversation.
import { createHash } from 'node:crypto';

import { Tokenizer } from '@huggingface/tokenizers';

import type { ChatMessage } from '@gyblos/protocol/chat';
import {
  hasToolTurns,
  type ToolCall,
  type ToolChatMessage,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { MODEL, renderChat, renderConversation } from './model';
import { renderAssistantOutput, renderToolConversation } from './tool-template';

export type ModelTokenizer = ReturnType<typeof createModelTokenizer>;

export function createModelTokenizer(artifacts: {
  tokenizer: string;
  config: string;
}) {
  for (const [body, expected] of [
    [artifacts.tokenizer, MODEL.tokenizerSha256],
    [artifacts.config, MODEL.configSha256],
  ]) {
    if (createHash('sha256').update(body!).digest('hex') !== expected) {
      throw new Error('Public tokenizer artifact hash mismatch.');
    }
  }
  const tokenizer = new Tokenizer(
    JSON.parse(artifacts.tokenizer),
    JSON.parse(artifacts.config),
  );
  const count = (text: string) =>
    tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  return {
    count,
    input: (prompt: string) => count(renderChat(prompt)),
    // Tools count as the template renders them; without tools or tool turns, as the text template.
    chat: (
      messages: readonly ToolChatMessage[],
      tools?: readonly ToolDefinition[],
    ) =>
      count(
        tools?.length || hasToolTurns(messages)
          ? renderToolConversation(messages, tools)
          : renderConversation(messages as readonly ChatMessage[]),
      ),
    output: (text: string, toolCalls?: readonly ToolCall[]) =>
      count(renderAssistantOutput(text, toolCalls)),
  };
}
