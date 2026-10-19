export { MODEL } from './constants.js';

// Exact single-user, no-tools branch of the pinned public Qwen chat template.
// Raw generation avoids a second, implicit Ollama chat template.
export function renderChat(prompt: string): string {
  if (!prompt || prompt.length > 4000 || /<\|.*?\|>|<\/?think>/.test(prompt)) {
    throw new Error('Unsupported prompt for the bounded single-user offer.');
  }
  return `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}
