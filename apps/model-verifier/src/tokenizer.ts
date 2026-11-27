import { readFile } from 'node:fs/promises';

import { homeLayout, type HomeEnvironment } from '@gyblos/config/home';
import { createModelTokenizer } from '@gyblos/engine-ollama';

import { MODEL_VERIFIER_CODES, ModelVerifierError } from './constants';

export async function outputTokenCounter(
  environment: HomeEnvironment = process.env,
): Promise<(text: string) => number> {
  const files = homeLayout(environment).artifacts.tokenizerFiles;
  try {
    const tokenizer = createModelTokenizer({
      tokenizer: await readFile(files.tokenizer, 'utf8'),
      config: await readFile(files.config, 'utf8'),
    });
    return tokenizer.count;
  } catch {
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.TOKENIZER_UNAVAILABLE);
  }
}
