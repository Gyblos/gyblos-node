import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const RUNTIME = import.meta.resolve('@gyblos/runtime');
const MODULES = {
  '@gyblos/node':
    'export const createNode=()=>({async start(){},async stop(){}});',
  '@gyblos/node/artifacts': 'export const prepareModelTokenizer=async()=>{};',
  '@gyblos/runtime': `export * from ${JSON.stringify(RUNTIME)};export const shutdownSignal=()=>({signalled:Promise.resolve(),dispose(){}});`,
} as const;

function runEntry(args: readonly string[], cwd: string) {
  const bin = new URL('../apps/node/src/bin.ts', import.meta.url).href;
  const program = `import {registerHooks} from 'node:module';
const modules=${JSON.stringify(MODULES)};
registerHooks({resolve(name,context,next){
const source=modules[name];
if(source)return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
return next(name,context);
}});
process.argv.push('bin',...${JSON.stringify(args)});
await import(${JSON.stringify(bin)});`;
  return spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      program,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
}

async function withEntryRun(
  use: (run: (args: readonly string[]) => ReturnType<typeof runEntry>) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-node-entry-'));
  try {
    use((args) => runEntry(args, directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('start, tokenizer and --version refuse extra arguments with usage', async () => {
  await withEntryRun((run) => {
    for (const args of [
      ['start', '--config', '/tmp/other.toml'],
      ['tokenizer', 'extra'],
      ['--version', 'extra'],
    ]) {
      const result = run(args);
      assert.ifError(result.error);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
      assert.match(result.stderr, /^Usage: gyblos start/);
    }
  });
});

void test('start, tokenizer and --version still run without extra arguments', async () => {
  await withEntryRun((run) => {
    const started = run(['start']);
    assert.ifError(started.error);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, '');
    assert.equal(started.stderr, '');
    const tokenizer = run(['tokenizer']);
    assert.ifError(tokenizer.error);
    assert.equal(tokenizer.status, 0, tokenizer.stderr);
    assert.match(tokenizer.stdout, /Pinned tokenizer verified\./);
    assert.equal(tokenizer.stderr, '');
    const version = run(['--version']);
    assert.ifError(version.error);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, 'source\n');
    assert.equal(version.stderr, '');
  });
});
