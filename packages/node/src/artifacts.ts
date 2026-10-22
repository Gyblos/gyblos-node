// Owns artifacts in node; it must not know lab orchestration or CLI processes.
import { readFile } from 'node:fs/promises';

import { TOKENIZER_FILES } from '@gyblos/config';
import { createModelTokenizer } from '@gyblos/engine-ollama';

export async function modelTokenizer() {
  return createModelTokenizer({
    tokenizer: await readFile(TOKENIZER_FILES.tokenizer, 'utf8'),
    config: await readFile(TOKENIZER_FILES.config, 'utf8'),
  });
}
