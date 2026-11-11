// Renders a conversation with the pinned Qwen3 chat template: no tools, thinking off, generation prompt added.
import type { ChatMessage } from '@gyblos/protocol/chat';

import { MODEL_LIMITS } from './constants';

export { MODEL } from './constants';

// Template control tokens and thinking tags are never content: they would let text forge turns.
const CONTROL = /<\|.*?\|>|<\/?think>/;

// The pinned public Qwen3 template's no-tools branch: an optional system turn, then each user and
// assistant turn, then the assistant's opening with an empty thought (enable_thinking=false). A lone user
// message renders exactly as the single-user branch always has. Raw generation avoids a second, implicit
// Ollama template.
export function renderConversation(messages: readonly ChatMessage[]): string {
  let rendered = '';
  for (const message of messages) {
    if (!message.content || CONTROL.test(message.content))
      throw new Error('Unsupported content for the chat template.');
    rendered += `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`;
  }
  if (!rendered || rendered.length > MODEL_LIMITS.maxConversationCharacters)
    throw new Error('Unsupported conversation for the chat template.');
  return `${rendered}<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

export const renderChat = (prompt: string) =>
  renderConversation([{ role: 'user', content: prompt }]);
