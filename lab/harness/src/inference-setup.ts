// Downloads the pinned tokenizer files and pulls the pinned model into the shared product artifacts
// directory using a temporary loopback Ollama server, then verifies both. Never touches role data.
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FILE_MODES, homeLayout, ROUTES, TIMEOUTS } from '@gyblos/config';
import { createOllama } from '@gyblos/engine-ollama';
import { MODEL } from '@gyblos/engine-ollama/model';
import { prepareModelTokenizer } from '@gyblos/node/artifacts';
import { assertOllamaModelsHome } from '@gyblos/node/home';
import { spawnChild, stopChild, waitReady } from '@gyblos/runtime';

import { GATE_HOSTS, GATE_PORTS, GATE_RETRIES } from './constants.js';

async function prepareGateArtifacts() {
  await prepareModelTokenizer();
  await assertOllamaModelsHome();
  await mkdir(homeLayout(process.env).artifacts.ollamaModels, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
}

async function pullGateModel() {
  const environment = {
    ...process.env,
    OLLAMA_HOST: GATE_HOSTS.ollamaSetupBind,
    OLLAMA_MODELS: resolve(homeLayout(process.env).artifacts.ollamaModels),
    OLLAMA_NO_CLOUD: '1',
  };
  const origin = GATE_HOSTS.ollamaSetup;
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
    throw new Error(
      `Setup needs unused loopback port ${GATE_PORTS.ollamaSetup}.`,
    );
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
      attempts: GATE_RETRIES.fixedStartup,
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

export async function setupInferenceGate() {
  await prepareGateArtifacts();
  await pullGateModel();
}
