// Exercises buyer tokenizer preparation in an isolated checkout with synthetic public artifacts.
// The real downloader and CLI run offline; no role keys, engine, RPC or payment is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';

// The child runs with a minimal environment, so the default home applies.
function artifactLayout() {
  return homeLayout({}).artifacts;
}

async function preparation(
  corrupt: false | 'tokenizer' | 'config' = false,
  seed = false,
  failure: 'oversize' | 'write' | undefined = undefined,
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-buyer-setup-'));
  const artifacts = {
    tokenizer: 'synthetic tokenizer',
    config: 'synthetic config',
  };
  if (seed) {
    await mkdir(join(directory, artifactLayout().tokenizer), {
      recursive: true,
    });
    await writeFile(
      join(directory, artifactLayout().tokenizerFiles.tokenizer),
      artifacts.tokenizer,
    );
    await writeFile(
      join(directory, artifactLayout().tokenizerFiles.config),
      artifacts.config,
    );
  }
  const digest = (body: string) =>
    createHash('sha256').update(body).digest('hex');
  const adapter = `export const MODEL={publicModel:'synthetic/model',revision:'pinned',
    tokenizerSha256:${JSON.stringify(digest(artifacts.tokenizer))},configSha256:${JSON.stringify(digest(artifacts.config))}};
    export function createModelTokenizer(input){if(input.tokenizer!==${JSON.stringify(artifacts.tokenizer)}||input.config!==${JSON.stringify(artifacts.config)})throw new Error('Public tokenizer artifact hash mismatch.');}`;
  const program = `import {registerHooks,syncBuiltinESMExports} from 'node:module';
    import fs from 'node:fs/promises';
    const failure=${JSON.stringify(failure)};
    if(failure==='write') {
      const originalWrite=fs.writeFile;
      fs.writeFile=async (path,data,options)=>{
        if(String(path).endsWith('tokenizer_config.json')) {
          await originalWrite(path,'partial',options);
          throw new Error('Synthetic write failure');
        }
        return originalWrite(path,data,options);
      };
      syncBuiltinESMExports();
    }

    registerHooks({resolve(name,context,next){if(name==='@gyblos/engine-ollama'||name==='@gyblos/engine-ollama/model')return {url:'data:text/javascript,'+encodeURIComponent(${JSON.stringify(adapter)}),shortCircuit:true};return next(name,context);}});
    globalThis.fetch=async url=>{
      if(!String(url).startsWith('https://huggingface.co/synthetic/model/resolve/pinned/'))throw new Error('Unexpected download');
      if(failure==='oversize') {
        let sent=0;
        return new Response(new ReadableStream({
          pull(controller){
            if(sent++<65)controller.enqueue(new Uint8Array(1024*1024));
            else controller.close();
          },
        }));
      }
      return new Response(String(url).endsWith('tokenizer.json')?${JSON.stringify(corrupt === 'tokenizer' ? 'corrupt' : artifacts.tokenizer)}:${JSON.stringify(corrupt === 'config' ? 'corrupt' : artifacts.config)});
    };
    await import(${JSON.stringify(import.meta.resolve('@gyblos/buyer/setup'))}).then(module=>module.main());`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      program,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
  return { directory, result, artifacts };
}

void test('a fresh buyer prepares pinned tokenizer files without an engine or role setup', async () => {
  const { directory, result, artifacts } = await preparation();
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('buyer preparation rejects a substituted tokenizer before writing artifacts', async () => {
  const { directory, result } = await preparation('tokenizer');
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    await assert.rejects(
      readFile(join(directory, artifactLayout().tokenizerFiles.tokenizer)),
      {
        code: 'ENOENT',
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a substituted config leaves both previously verified tokenizer files unchanged', async () => {
  const { directory, result, artifacts } = await preparation('config', true);
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('buyer preparation caps streamed bodies without trusting Content-Length', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    'oversize',
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(NODE_ERROR_CODES.TOKENIZER_DOWNLOAD_TOO_LARGE),
    );
    for (const [name, path] of Object.entries(artifactLayout().tokenizerFiles))
      assert.equal(
        await readFile(join(directory, path), 'utf8'),
        artifacts[name as keyof typeof artifacts],
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a failed staged write preserves existing artifacts and removes temporary files', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    'write',
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Synthetic write failure/);
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
    assert.deepEqual(
      (await readdir(join(directory, artifactLayout().tokenizer))).sort(),
      ['tokenizer.json', 'tokenizer_config.json'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
