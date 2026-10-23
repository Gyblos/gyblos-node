// Executes the published migration commands against synthetic directories only.
// Refusal must preserve existing state; successful moves must retain custom-home key paths.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const guide = await readFile(
  new URL('../docs/running-a-node.md', import.meta.url),
  'utf8',
);
const migration = guide
  .split('### Moving data from the old layout')[1]!
  .split('## Roles and files')[0]!;
const commands = [...migration.matchAll(/```sh\n([\s\S]*?)```/g)]
  .map((match) => match[1]!)
  .join('\n');

async function fixture(
  run: (directory: string, original: string) => Promise<void>,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'gyblos-migration-')),
  );
  try {
    for (const path of [
      '.local/p2p',
      '.local/devnet/tokenizer',
      '.local/ollama/models',
      '.local/identity/keys',
    ])
      await mkdir(join(directory, path), { recursive: true });
    const original = JSON.stringify({
      keys: { buyer: join(directory, '.local/devnet/buyer.json') },
      rpcUrl: 'http://synthetic.invalid',
    });
    await writeFile(join(directory, '.local/devnet/config.json'), original);
    await writeFile(join(directory, '.local/devnet/buyer.json'), 'synthetic');
    await writeFile(
      join(directory, '.local/identity/keys/fixture.json'),
      'synthetic',
    );
    await run(directory, original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function migrate(directory: string, labHome?: string) {
  return spawnSync('/bin/sh', ['-c', commands], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      ...(labHome ? { GYBLOS_LAB_HOME: labHome } : {}),
    },
  });
}

void test('documented migration stops before rewriting an existing lab destination', async () => {
  await fixture(async (directory) => {
    const destination = join(directory, '.local/lab');
    await mkdir(destination);
    const existing = JSON.stringify({
      keys: { buyer: join(directory, '.local/devnet/existing.json') },
    });
    await writeFile(join(destination, 'config.json'), existing);
    const result = migrate(directory);
    assert.notEqual(result.status, 0);
    assert.equal(
      await readFile(join(destination, 'config.json'), 'utf8'),
      existing,
    );
    await assert.rejects(access(join(destination, 'config.json.bak')));
    await assert.rejects(access(join(destination, 'identity')));
    await access(join(directory, '.local/devnet/config.json'));
  });
});

for (const custom of [false, true]) {
  void test(`documented migration preserves configuration at ${custom ? 'a custom' : 'the default'} lab home`, async () => {
    await fixture(async (directory, original) => {
      const labHome = custom
        ? join(directory, "custom lab & 'home'")
        : '.local/lab';
      const result = migrate(directory, custom ? labHome : undefined);
      assert.equal(result.status, 0, result.stderr);
      const destination = resolve(directory, labHome);
      const value: unknown = JSON.parse(
        await readFile(join(destination, 'config.json'), 'utf8'),
      );
      assert.deepEqual(value, {
        keys: { buyer: join(destination, 'buyer.json') },
        rpcUrl: 'http://synthetic.invalid',
      });
      assert.equal(
        await readFile(join(destination, 'config.json.bak'), 'utf8'),
        original,
      );
      assert.equal(
        await readFile(join(destination, 'buyer.json'), 'utf8'),
        'synthetic',
      );
      assert.equal(
        await readFile(join(destination, 'identity/keys/fixture.json'), 'utf8'),
        'synthetic',
      );
      await assert.rejects(access(join(directory, '.local/devnet')));
    });
  });
}
