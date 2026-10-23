// Downloads, verifies and loads the pinned public recount tokenizer. No engines, wallets or RPC.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { FILE_MODES, TOKENIZER_DIR, TOKENIZER_FILES } from '@gyblos/config';
import { createModelTokenizer } from '@gyblos/engine-ollama';
import { MODEL } from '@gyblos/engine-ollama/model';

import {
  NODE_ERROR_CODES,
  TOKENIZER_DOWNLOAD_TIMEOUT_MS,
  TOKENIZER_ORIGIN,
} from './constants.js';
import { NodeError } from './errors.js';

export async function modelTokenizer() {
  return createModelTokenizer({
    tokenizer: await readFile(TOKENIZER_FILES.tokenizer, 'utf8'),
    config: await readFile(TOKENIZER_FILES.config, 'utf8'),
  });
}

// Verify both downloads before publishing either file so a bad response cannot replace a good tokenizer.
export async function prepareModelTokenizer() {
  const paths = [TOKENIZER_FILES.tokenizer, TOKENIZER_FILES.config];
  const bodies: string[] = [];
  for (const path of paths) {
    const response = await fetch(
      `${TOKENIZER_ORIGIN}/${MODEL.publicModel}/resolve/${MODEL.revision}/${basename(path)}`,
      {
        signal: AbortSignal.timeout(TOKENIZER_DOWNLOAD_TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new NodeError(NODE_ERROR_CODES.TOKENIZER_DOWNLOAD_FAILED);
    bodies.push(await response.text());
  }
  const tokenizer = bodies[0]!;
  const config = bodies[1]!;
  createModelTokenizer({ tokenizer, config });
  await mkdir(TOKENIZER_DIR, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  for (const [index, path] of paths.entries())
    await writeFile(path, bodies[index]!, { mode: FILE_MODES.privateFile });
}
