// Runs tokenizer preparation against synthetic fetch/filesystem fixtures in temporary child checkouts.
// No real downloads, engines, operational keys or network are permitted.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { homeLayout } from '@gyblos/config';

const PRODUCT_ENTRIES = {
  buyer: '@gyblos/buyer/setup',
  node: '@gyblos/node-app/tokenizer',
} as const;

// The child runs with a minimal environment, so the default home applies.
export function artifactLayout() {
  return homeLayout({}).artifacts;
}

export async function preparation(
  corrupt: false | 'tokenizer' | 'config' = false,
  seed = false,
  failure: 'oversize' | 'write' | undefined = undefined,
  lab = false,
  legacyDirectories: readonly string[] = [],
  // The product entry to run when not in the lab: the buyer's setup or the role-neutral node command.
  entry: keyof typeof PRODUCT_ENTRIES = 'buyer',
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-tokenizer-setup-'));
  for (const legacy of legacyDirectories)
    await mkdir(join(directory, legacy), { recursive: true });
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
    export const createOllama=()=>{throw new Error('Unexpected engine')};
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
    if(${lab}) registerHooks({resolve(name,context,next){if(name==='@gyblos/runtime')return {url:'data:text/javascript,'+encodeURIComponent("export const isMain=()=>true; export const spawnChild=()=>{throw new Error('Unexpected process')}; export const stopChild=()=>{}; export const waitReady=()=>{};"),shortCircuit:true};return next(name,context);}});
    globalThis.fetch=async url=>{
      if(${lab} && String(url).endsWith('/api/version')) return new Response('{}');
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
    await import(${JSON.stringify(import.meta.resolve(lab ? '@gyblos/lab-harness/commands/inference-setup' : PRODUCT_ENTRIES[entry]))}).then(module=>${lab ? 'undefined' : 'module.main()'});`;
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
