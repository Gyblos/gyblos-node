// Renders a prompt with the exact single-user, no-tools branch of the pinned Qwen chat template.
import { MODEL_LIMITS } from './constants';

export { MODEL } from './constants';

// Exact single-user, no-tools branch of the pinned public Qwen chat template.
// Raw generation avoids a second, implicit Ollama chat template.
export function renderChat(prompt: string): string {
  if (
    !prompt ||
    prompt.length > MODEL_LIMITS.maxPromptCharacters ||
    /<\|.*?\|>|<\/?think>/.test(prompt)
  ) {
    throw new Error('Unsupported prompt for the bounded single-user offer.');
  }
  return `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}
