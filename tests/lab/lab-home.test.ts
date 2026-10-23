// Checks that lab state lives in its own home (GYBLOS_LAB_HOME, GYBLOS_GATE_CONFIG override) and that
// legacy .local/devnet lab state fails closed. Synthetic temporary directories only; nothing is read.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { LEGACY_LOCAL_PATHS } from '@gyblos/config';
import { labPaths, LEGACY_LAB_PATHS } from '@gyblos/lab-harness/constants';
import { setupGate } from '@gyblos/lab-harness/setup';
import { assertLabHome, configPath } from '@gyblos/lab-harness/wallet';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';

async function withLabEnvironment(
  env: Record<string, string | undefined>,
  run: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-lab-home-test-'));
  const original = process.cwd();
  const saved = {
    GYBLOS_LAB_HOME: process.env.GYBLOS_LAB_HOME,
    GYBLOS_GATE_CONFIG: process.env.GYBLOS_GATE_CONFIG,
  };
  try {
    process.chdir(directory);
    for (const [name, value] of Object.entries({ ...saved, ...env }))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await run(directory);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
}

void test('lab paths follow GYBLOS_LAB_HOME and GYBLOS_GATE_CONFIG keeps overriding the config', async () => {
  await withLabEnvironment(
    { GYBLOS_LAB_HOME: undefined, GYBLOS_GATE_CONFIG: undefined },
    async () => {
      assert.equal(labPaths().config, '.local/lab/config.json');
      assert.equal(
        labPaths().journals.inference,
        '.local/lab/inference-attempt.json',
      );
      assert.equal(configPath(), resolve('.local/lab/config.json'));
    },
  );
  await withLabEnvironment(
    {
      GYBLOS_LAB_HOME: '/lab-data',
      GYBLOS_GATE_CONFIG: '/elsewhere/config.json',
    },
    async () => {
      assert.equal(labPaths().lock, '/lab-data/buyer.lock');
      assert.equal(configPath(), '/elsewhere/config.json');
    },
  );
});

void test('each legacy lab path blocks a missing lab home until it is moved', async () => {
  assert.ok(LEGACY_LAB_PATHS.includes(LEGACY_LOCAL_PATHS.labMeasurements));
  for (const legacyPath of LEGACY_LAB_PATHS)
    await withLabEnvironment(
      { GYBLOS_LAB_HOME: undefined, GYBLOS_GATE_CONFIG: undefined },
      async () => {
        await assertLabHome();
        await mkdir(LEGACY_LOCAL_PATHS.lab, { recursive: true });
        await writeFile(legacyPath, 'synthetic', { mode: 0o000 });
        await assert.rejects(
          assertLabHome(),
          (error: Error & { code?: string }) => {
            assert.equal(error.code, NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT);
            assert.ok(error.message.includes(legacyPath));
            assert.ok(error.message.includes('.local/lab'));
            return true;
          },
        );
        // An empty lab home is not enough; moving the legacy file is.
        await mkdir('.local/lab');
        await assert.rejects(assertLabHome());
        await rename(legacyPath, join('.local/lab', basename(legacyPath)));
        await assertLabHome();
      },
    );
});

void test('a legacy product tokenizer alone does not block the lab home', async () => {
  await withLabEnvironment(
    { GYBLOS_LAB_HOME: undefined, GYBLOS_GATE_CONFIG: undefined },
    async () => {
      await mkdir(LEGACY_LOCAL_PATHS.tokenizer, { recursive: true });
      await assertLabHome();
    },
  );
});

void test('lab setup names the directory that holds the new keys', async () => {
  await withLabEnvironment(
    { GYBLOS_LAB_HOME: undefined, GYBLOS_GATE_CONFIG: undefined },
    async (directory) => {
      const keyDirectory = join(directory, 'elsewhere');
      process.env.GYBLOS_GATE_CONFIG = join(keyDirectory, 'config.json');
      const messages: unknown[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => messages.push(...args);
      try {
        await setupGate();
      } finally {
        console.log = original;
      }
      const output = messages.join(' ');
      assert.ok(
        output.includes(`Private keys stay in ${keyDirectory}.`),
        output,
      );
    },
  );
});
