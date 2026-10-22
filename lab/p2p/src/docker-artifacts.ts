// Owns laboratory docker artifacts; product code must not depend on this module.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { OLLAMA_MODELS_PATH, P2P, TOKENIZER_FILES } from '@gyblos/config';
import { createModelTokenizer, MODEL } from '@gyblos/engine-ollama';
import { verifyManifestLineage } from '@gyblos/engine-ollama/artifacts';

import { composeArgs, docker } from './docker-command.js';

async function digestFile(path: string) {
  assert.ok((await lstat(path)).isFile());
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function modelArchive(operatorRoot: string) {
  const models = resolve(operatorRoot, OLLAMA_MODELS_PATH);
  const [name, tag] = MODEL.name.split(':');
  assert.ok(name && tag);
  const manifest = `manifests/registry.ollama.ai/library/${name}/${tag}`;
  const bytes = await readFile(resolve(models, manifest));
  const parsed = await verifyManifestLineage(
    bytes,
    MODEL.digest,
    async (digest) => {
      assert.match(digest, /^sha256:[a-f0-9]{64}$/);
      return readFile(resolve(models, `blobs/${digest.replace(':', '-')}`));
    },
  );
  const paths: string[] = [];
  const normalized =
    createHash('sha256').update(bytes).digest('hex') === MODEL.digest
      ? bytes
      : await readFile(resolve(models, `blobs/sha256-${MODEL.digest}`));
  for (const layer of [parsed.config, ...parsed.layers]) {
    assert.match(layer.digest, /^sha256:[a-f0-9]{64}$/);
    const file = `blobs/${layer.digest.replace(':', '-')}`;
    assert.equal(
      await digestFile(resolve(models, file)),
      layer.digest.slice('sha256:'.length),
    );
    assert.equal((await lstat(resolve(models, file))).size, layer.size);
    paths.push(file);
  }
  await mkdir(dirname(P2P.docker.modelArchive), { recursive: true });
  await new Promise<void>((done, reject) => {
    const child = spawn(
      'tar',
      ['-cf', P2P.docker.modelArchive, '-C', models, ...paths],
      { stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error('Public model archive failed.')),
    );
  });
  const staging = await mkdtemp(resolve(tmpdir(), 'gyblos-model-'));
  try {
    await mkdir(dirname(resolve(staging, manifest)), { recursive: true });
    await writeFile(resolve(staging, manifest), normalized);
    await new Promise<void>((done, reject) => {
      const child = spawn(
        'tar',
        ['-rf', resolve(P2P.docker.modelArchive), '-C', staging, manifest],
        { stdio: 'ignore' },
      );
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? done()
          : reject(new Error('Pinned manifest archive failed.')),
      );
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return resolve(P2P.docker.modelArchive);
}

export async function provisionArtifacts(
  project: string,
  role: string,
  operatorRoot: string,
  archive: string,
  environment: NodeJS.ProcessEnv,
) {
  const tokenizer = await readFile(
    resolve(operatorRoot, TOKENIZER_FILES.tokenizer),
  );
  const config = await readFile(resolve(operatorRoot, TOKENIZER_FILES.config));
  createModelTokenizer({
    tokenizer: tokenizer.toString('utf8'),
    config: config.toString('utf8'),
  });
  for (const [path, bytes] of [
    [TOKENIZER_FILES.tokenizer, tokenizer],
    [TOKENIZER_FILES.config, config],
  ] as const) {
    await docker(
      composeArgs(
        project,
        [
          'run',
          '--rm',
          '-T',
          '--no-deps',
          role,
          'node',
          '-e',
          `const fs=require('fs');const path=process.argv[1];fs.mkdirSync(require('path').dirname(path),{recursive:true});const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>fs.writeFileSync(path,Buffer.concat(chunks)));`,
          path,
        ],
        environment,
      ),
      bytes,
      environment,
    );
  }
  if (role === 'seller')
    await new Promise<void>((done, reject) => {
      const args = composeArgs(
        project,
        [
          'run',
          '--rm',
          '-T',
          '--no-deps',
          role,
          'sh',
          '-c',
          `mkdir -p ${OLLAMA_MODELS_PATH} && tar -xf - -C ${OLLAMA_MODELS_PATH}`,
        ],
        environment,
      );
      const child = spawn('docker', args, {
        env: environment,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const source = createReadStream(archive);
      source.on('error', reject);
      child.stdin.on('error', () => {});
      source.pipe(child.stdin);
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? done()
          : reject(new Error('Public model provisioning failed.')),
      );
    });
}
