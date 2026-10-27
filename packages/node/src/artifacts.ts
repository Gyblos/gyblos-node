// Downloads, verifies and loads the pinned public recount tokenizer in <home>/artifacts/tokenizer/.
// No engines, wallets or RPC.
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import { FILE_MODES, homeLayout, type HomeEnvironment } from '@gyblos/config';
import { createModelTokenizer } from '@gyblos/engine-ollama';
import { MODEL } from '@gyblos/engine-ollama/model';

import {
  NODE_ERROR_CODES,
  TOKENIZER_DOWNLOAD_MAX_BYTES,
  TOKENIZER_DOWNLOAD_TIMEOUT_MS,
  TOKENIZER_ORIGIN,
} from './constants';
import { NodeError } from './errors';
import { assertTokenizerHome } from './home';

export async function modelTokenizer(
  environment: HomeEnvironment = process.env,
) {
  await assertTokenizerHome(environment);
  const files = homeLayout(environment).artifacts.tokenizerFiles;
  return createModelTokenizer({
    tokenizer: await readFile(files.tokenizer, 'utf8'),
    config: await readFile(files.config, 'utf8'),
  });
}

// Count actual decoded bytes so absent or misleading response headers cannot bypass the cap.
async function boundedArtifactBody(response: Response) {
  if (!response.ok || !response.body)
    throw new NodeError(NODE_ERROR_CODES.TOKENIZER_DOWNLOAD_FAILED);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TOKENIZER_DOWNLOAD_MAX_BYTES) {
        await reader.cancel();
        throw new NodeError(NODE_ERROR_CODES.TOKENIZER_DOWNLOAD_TOO_LARGE);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

// Verify both downloads before publishing either file so a bad response cannot replace a good tokenizer.
export async function prepareModelTokenizer() {
  await assertTokenizerHome();
  const { tokenizer: directory, tokenizerFiles: files } = homeLayout(
    process.env,
  ).artifacts;
  const paths = [files.tokenizer, files.config];
  const bodies: string[] = [];
  for (const path of paths) {
    const response = await fetch(
      `${TOKENIZER_ORIGIN}/${MODEL.publicModel}/resolve/${MODEL.revision}/${basename(path)}`,
      {
        signal: AbortSignal.timeout(TOKENIZER_DOWNLOAD_TIMEOUT_MS),
      },
    );
    bodies.push(await boundedArtifactBody(response));
  }
  const tokenizer = bodies[0]!;
  const config = bodies[1]!;
  createModelTokenizer({ tokenizer, config });
  await mkdir(directory, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  const staging = await mkdtemp(join(directory, '.tokenizer-'));
  try {
    for (const [index, path] of paths.entries())
      await writeFile(join(staging, basename(path)), bodies[index]!, {
        flag: 'wx',
        mode: FILE_MODES.privateFile,
      });
    // Each rename is atomic, not the pair. Readers still hash-check both pinned artifacts.
    for (const path of paths) await rename(join(staging, basename(path)), path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
