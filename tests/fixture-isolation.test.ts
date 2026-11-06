// Synthetic fixture imports must not probe native sockets or read existing operator state.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

void test('synthetic reader and deadline fixtures import without native socket setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-pure-fixtures-'));
  const modules = ['native-reader', 'native-reader-ready', 'test-deadline', 'test-abort', 'test-stalled-writer'].map((name) => new URL(`./support/${name}.ts`, import.meta.url).href);
  const script = `
    import dgram from 'node:dgram';
    import { syncBuiltinESMExports } from 'node:module';
    dgram.createSocket = () => { throw new Error('Native socket setup forbidden in synthetic fixtures.'); };
    syncBuiltinESMExports();
    for (const target of ${JSON.stringify(modules)}) await import(target);
    console.log('pure');
  `;
  try {
    const output = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
      cwd: root, timeout: 10000,
      env: { PATH: process.env.PATH, GYBLOS_HOME: join(root, 'product'), GYBLOS_LAB_HOME: join(root, 'lab') },
    });
    assert.equal(output.stdout.trim(), 'pure');
  } finally { await rm(root, { recursive: true, force: true }); }
});
