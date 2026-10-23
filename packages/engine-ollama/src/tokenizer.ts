// Builds the recount tokenizer from hash-checked public tokenizer files; counts output and templated input.
import { createHash } from 'node:crypto';

import { Tokenizer } from '@huggingface/tokenizers';

import { MODEL, renderChat } from './model.js';

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
  return { count, input: (prompt: string) => count(renderChat(prompt)) };
}
