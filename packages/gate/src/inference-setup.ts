import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { HOSTS, localPath, PORTS } from '@gyblos/config';
import {
  createModelTokenizer,
  createOllama,
  MODEL,
} from '@gyblos/inference-ollama/index';

export async function setupInferenceGate() {
  const directory = localPath('tokenizer');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir('.local/ollama/models', { recursive: true, mode: 0o700 });
  for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
    const response = await fetch(
      `https://huggingface.co/${MODEL.publicModel}/resolve/${MODEL.revision}/${name}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error('Pinned tokenizer download failed.');
    await writeFile(`${directory}/${name}`, await response.text(), {
      mode: 0o600,
    });
  }
  createModelTokenizer({
    tokenizer: await readFile(`${directory}/tokenizer.json`, 'utf8'),
    config: await readFile(`${directory}/tokenizer_config.json`, 'utf8'),
  });
  const env = {
    ...process.env,
    OLLAMA_HOST: HOSTS.ollamaSetupBind,
    OLLAMA_MODELS: resolve('.local/ollama/models'),
    OLLAMA_NO_CLOUD: '1',
  };
  const origin = HOSTS.ollamaSetup;
  let occupied = false;
  try {
    await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(500) });
    occupied = true;
  } catch {
    /* no listener */
  }
  if (occupied)
    throw new Error(`Setup needs unused loopback port ${PORTS.ollamaSetup}.`);
  const server = spawn('ollama', ['serve'], { env, stdio: 'ignore' });
  let startupError = false;
  server.on('error', () => {
    startupError = true;
  });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (startupError || server.exitCode !== null)
        throw new Error('Local Ollama startup failed.');
      try {
        const response = await fetch(`${origin}/api/version`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Local Ollama setup timed out.');
    const child = spawn('ollama', ['pull', MODEL.name], {
      env,
      stdio: 'inherit',
    });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error('Pinned model download failed.');
    await createOllama(origin).assertModel();
    console.log('Pinned local model and public tokenizer artifacts verified.');
  } finally {
    if (server.pid && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (server.exitCode === null && server.signalCode === null)
        server.kill('SIGKILL');
    }
  }
}
