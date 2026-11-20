// Checks that every lab entry point that writes lab state refuses legacy .local/devnet state first, that
// a pre-created empty lab home cannot silence that check, and that nothing is written. Synthetic temp cwd only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { labLayout, LEGACY_LOCAL_PATHS } from '@gyblos/config';
import {
  CONFIG_FILENAME,
  LAB_JOURNAL_FILENAMES,
  LEGACY_LAB_PATHS,
  WALLET_ROLES,
} from '@gyblos/lab-harness/constants';
import { assertLabHome } from '@gyblos/lab-harness/wallet';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';

import { loadOrCreateKey } from '../../lab/tools/identity-keys';
import { startLocalValidator } from './identity-validator';

const LAB_ENVIRONMENT = [
  'GYBLOS_HOME',
  'GYBLOS_LAB_HOME',
  'GYBLOS_GATE_CONFIG',
  'PATH',
];

async function inLegacyLabCwd(
  options: { emptyLabHome: boolean; legacyFiles: readonly string[] },
  run: () => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-lab-guard-test-'));
  const original = process.cwd();
  const saved = LAB_ENVIRONMENT.map((name) => [name, process.env[name]]);
  try {
    process.chdir(directory);
    delete process.env.GYBLOS_HOME;
    delete process.env.GYBLOS_LAB_HOME;
    delete process.env.GYBLOS_GATE_CONFIG;
    await mkdir(LEGACY_LOCAL_PATHS.lab, { recursive: true });
    for (const name of options.legacyFiles)
      await writeFile(join(LEGACY_LOCAL_PATHS.lab, name), 'synthetic');
    if (options.emptyLabHome) await mkdir(labLayout(process.env).root);
    await run();
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    process.exitCode = undefined;
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
}

async function labHomeEntries() {
  try {
    return await readdir(labLayout(process.env).root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isLegacyLayout(error: Error & { code?: string }) {
  assert.equal(error.code, NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT);
  return true;
}

void test('legacy devnet key files or measurement salt alone block the lab home', async () => {
  const names = [
    ...Object.values(WALLET_ROLES).map((role) => `${role}.json`),
    'measurement-salt',
  ];
  for (const name of names) {
    assert.ok(LEGACY_LAB_PATHS.includes(join(LEGACY_LOCAL_PATHS.lab, name)));
    await inLegacyLabCwd(
      { emptyLabHome: false, legacyFiles: [name] },
      async () => {
        await assert.rejects(assertLabHome(), isLegacyLayout);
      },
    );
  }
});

void test('a pre-created empty lab home does not silence legacy lab state', async () => {
  await inLegacyLabCwd(
    {
      emptyLabHome: true,
      legacyFiles: [CONFIG_FILENAME, LAB_JOURNAL_FILENAMES.inference],
    },
    async () => {
      // A lock file or identity scratch is not lab state either.
      await writeFile(join(labLayout(process.env).root, 'buyer.lock'), '');
      await mkdir(labLayout(process.env).identityKeys, { recursive: true });
      await assert.rejects(assertLabHome(), isLegacyLayout);
    },
  );
});

void test('identity tools refuse legacy lab state before writing keys or starting a validator', async () => {
  for (const emptyLabHome of [false, true]) {
    await inLegacyLabCwd(
      {
        emptyLabHome,
        legacyFiles: [CONFIG_FILENAME, LAB_JOURNAL_FILENAMES.inference],
      },
      async () => {
        process.env.PATH = '';
        await assert.rejects(
          loadOrCreateKey('synthetic-guard'),
          isLegacyLayout,
        );
        await assert.rejects(startLocalValidator(), isLegacyLayout);
        assert.deepEqual(await labHomeEntries(), []);
      },
    );
  }
});
