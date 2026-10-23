// Downloads the pinned tokenizer files and pulls the pinned model into a private Ollama models dir
// using a temporary loopback Ollama server, then verifies both.
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import {
  FILE_MODES,
  HOSTS,
  OLLAMA_MODELS_PATH,
  PORTS,
  RETRIES,
  ROUTES,
  TIMEOUTS,
  TOKENIZER_DIR,
  TOKENIZER_FILES,
} from '@gyblos/config';
import {
  createModelTokenizer,
  createOllama,
  MODEL,
} from '@gyblos/engine-ollama';
import { spawnChild, stopChild, waitReady } from '@gyblos/runtime';

import { PUBLIC_ORIGINS } from './constants.js';

export async function setupInferenceGate() {
  const directory = TOKENIZER_DIR;
  await mkdir(directory, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  await mkdir(OLLAMA_MODELS_PATH, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  for (const path of [TOKENIZER_FILES.tokenizer, TOKENIZER_FILES.config]) {
    const name = basename(path);
    const response = await fetch(
      `${PUBLIC_ORIGINS.tokenizer}/${MODEL.publicModel}/resolve/${MODEL.revision}/${name}`,
      { signal: AbortSignal.timeout(TIMEOUTS.artifactDownload) },
    );
    if (!response.ok) throw new Error('Pinned tokenizer download failed.');
    await writeFile(path, await response.text(), {
      mode: FILE_MODES.privateFile,
    });
  }
  createModelTokenizer({
    tokenizer: await readFile(TOKENIZER_FILES.tokenizer, 'utf8'),
    config: await readFile(TOKENIZER_FILES.config, 'utf8'),
  });
  const environment = {
    ...process.env,
    OLLAMA_HOST: HOSTS.ollamaSetupBind,
    OLLAMA_MODELS: resolve(OLLAMA_MODELS_PATH),
    OLLAMA_NO_CLOUD: '1',
  };
  const origin = HOSTS.ollamaSetup;
  let occupied = false;
  try {
    await fetch(`${origin}${ROUTES.ollamaVersion}`, {
      signal: AbortSignal.timeout(TIMEOUTS.readinessRequest),
    });
    occupied = true;
  } catch {
    /* no listener */
  }
  if (occupied)
    throw new Error(`Setup needs unused loopback port ${PORTS.ollamaSetup}.`);
  const server = spawnChild('ollama', ['serve'], {
    env: environment,
    stdio: 'ignore',
  });
  let startupError = false;
  server.on('error', () => {
    startupError = true;
  });
  try {
    await waitReady(server, `${origin}${ROUTES.ollamaVersion}`, {
      attempts: RETRIES.fixedStartup,
      parseBody: false,
      startupError: () => startupError,
      checkSignalCode: false,
      exitMessage: 'Local Ollama startup failed.',
      timeoutMessage: 'Local Ollama setup timed out.',
    });
    const child = spawnChild('ollama', ['pull', MODEL.name], {
      env: environment,
      stdio: 'inherit',
    });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error('Pinned model download failed.');
    await createOllama(origin).assertModel();
    console.log('Pinned local model and public tokenizer artifacts verified.');
  } finally {
    if (server.pid && server.exitCode === null) await stopChild(server);
  }
}
