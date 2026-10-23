// Checks that every lab entry point that writes lab state refuses legacy .local/devnet state first, that
// a pre-created empty lab home cannot silence that check, and that nothing is written. Synthetic temp cwd only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout, labLayout, LEGACY_LOCAL_PATHS } from '@gyblos/config';
import { main as fixedBuyerGate } from '@gyblos/lab-harness/cli/buyer';
import { main as exactGate } from '@gyblos/lab-harness/cli/exact';
import { main as inferenceGate } from '@gyblos/lab-harness/cli/inference';
import { failureGate } from '@gyblos/lab-harness/commands/failures';
import {
  CONFIG_FILENAME,
  LAB_JOURNAL_FILENAMES,
  LEGACY_LAB_PATHS,
  WALLET_ROLES,
} from '@gyblos/lab-harness/constants';
import { setupGate } from '@gyblos/lab-harness/setup';
import { assertLabHome } from '@gyblos/lab-harness/wallet';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';

import { loadOrCreateKey } from '../../lab/tools/identity-keys.js';
import { startLocalValidator } from './identity-validator.js';

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

// The fixed buyer gate CLI reports failures on stderr and the exit code instead of rejecting.
async function fixedBuyerGateMessage() {
  const messages: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => messages.push(...args);
  try {
    await fixedBuyerGate();
  } finally {
    console.error = original;
  }
  assert.equal(process.exitCode, 1);
  return messages.join(' ');
}

const ENTRY_POINTS: Record<string, () => Promise<unknown>> = {
  'gate:inference': inferenceGate,
  'gate:exact': exactGate,
  'gate:failures': failureGate,
  'gate:setup': setupGate,
  'identity keys': () => loadOrCreateKey('synthetic-guard'),
  'identity validator': async () => {
    // Nothing must spawn: an empty PATH makes any validator start fail.
    process.env.PATH = '';
    return startLocalValidator();
  },
};

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

void test('every lab entry point refuses legacy lab state before writing lab state', async () => {
  const entries = [
    ...Object.entries(ENTRY_POINTS),
    ['gate:buyer', null] as const,
  ];
  for (const emptyLabHome of [false, true])
    for (const [name, entry] of entries)
      await inLegacyLabCwd(
        {
          emptyLabHome,
          legacyFiles: [CONFIG_FILENAME, LAB_JOURNAL_FILENAMES.inference],
        },
        async () => {
          if (entry) await assert.rejects(entry(), isLegacyLayout, name);
          else
            assert.match(
              await fixedBuyerGateMessage(),
              new RegExp(NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT),
              name,
            );
          assert.deepEqual(await labHomeEntries(), [], name);
          if (!emptyLabHome)
            await assert.rejects(
              readdir(labLayout(process.env).root),
              { code: 'ENOENT' },
              name,
            );
        },
      );
});

void test('inference refuses legacy models before any lock, network call or engine startup', async () => {
  await inLegacyLabCwd({ emptyLabHome: true, legacyFiles: [] }, async () => {
    await mkdir(LEGACY_LOCAL_PATHS.ollamaModels, { recursive: true });
    await writeFile(join(labLayout(process.env).root, CONFIG_FILENAME), '{}');
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    process.env.PATH = '';
    globalThis.fetch = async () => {
      fetches++;
      throw new Error('Unexpected network');
    };
    try {
      await assert.rejects(inferenceGate(), isLegacyLayout);
      assert.equal(fetches, 0);
      assert.deepEqual(await labHomeEntries(), [CONFIG_FILENAME]);
      await assert.rejects(readdir(homeLayout(process.env).root), {
        code: 'ENOENT',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
