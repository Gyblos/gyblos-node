// Owns the `gyblos doctor` contract for the seller: read-only checks with static codes, the public
// NodeId/owner summary, exit codes 0/1 and no secret, home path or RPC path in any output.
// Offline; synthetic role files in a temporary home, injected port and program probes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { runCli, type CliContext } from '@gyblos/node-app/cli';

import {
  FAKE_SECRET,
  REPOSITORY_ROOT,
} from './support/node-config-fixtures.js';

const NODE_ID = 'ab'.repeat(32);
const RELAY_TOKEN = `${FAKE_SECRET}-relay-token`;
const RPC_URL = `https://rpc.example.com/v2/${FAKE_SECRET}`;
const KEY_FILES = [
  'owner.json',
  'authorizer.json',
  'facilitator.json',
  'node.key',
];
const MANAGED = '{ kind = "ollama", url = "http://127.0.0.1:11436" }';
const FREE_TOML = `version = 1\n[node]\nnetwork = "devnet"\n[[offers]]\nmodel = "qwen3:0.6b"\nreasoning = ["off"]\nengine = ${MANAGED}\nfree = { daily_token_cap = 20000, per_buyer_cap = 2000 }\n`;
const PAID_TOML = FREE_TOML.replace(
  'free = { daily_token_cap = 20000, per_buyer_cap = 2000 }',
  'price = { input_per_mtok = "1", output_per_mtok = "2", currency = "USDC" }',
);

interface Fixture {
  root: string;
  home: string;
  bin: string;
  owner: string;
}

async function fixture(options: { role?: boolean; keyMode?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-doctor-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const seller = join(home, 'seller');
  await mkdir(seller, { recursive: true, mode: 0o700 });
  await mkdir(bin);
  const [owner, authorizer, facilitator, payTo, buyer, mint] =
    await Promise.all(
      Array.from(
        { length: 6 },
        async () => (await generateKeyPairSigner()).address,
      ),
    );
  if (options.role !== false) {
    await writeFile(
      join(seller, 'role.json'),
      JSON.stringify({
        schemaVersion: 1,
        role: 'seller',
        rpcUrl: RPC_URL,
        mint,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId: NODE_ID,
        buyer,
        owner,
        authorizer,
        facilitator,
        payTo,
      }),
    );
    for (const name of KEY_FILES) {
      // Never real key material: doctor only checks presence and permissions.
      await writeFile(join(seller, name), '[]');
      await chmod(join(seller, name), options.keyMode ?? 0o600);
    }
  }
  return { root, home, bin, owner: owner! } satisfies Fixture;
}

async function withOllama(fixture: Fixture) {
  const binary = join(fixture.bin, 'ollama');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);
  const manifest = join(
    fixture.home,
    'artifacts',
    'ollama-models',
    'manifests',
    'registry.ollama.ai',
    'library',
    'qwen3',
  );
  await mkdir(manifest, { recursive: true });
  await writeFile(join(manifest, '0.6b'), '{}');
}

async function listTree(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries.map((entry) => join(entry.parentPath, entry.name)).sort();
}

async function doctor(
  fixture: Fixture,
  args: string[] = [],
  env: Record<string, string> = {},
  probes: NonNullable<CliContext['doctor']> = {},
) {
  let stdout = '';
  let stderr = '';
  const programCalls: string[] = [];
  const code = await runCli(['doctor', ...args], {
    env: {
      GYBLOS_HOME: fixture.home,
      PATH: fixture.bin,
      GYBLOS_RELAY_TOKEN: RELAY_TOKEN,
      ...env,
    },
    cwd: fixture.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    doctor: {
      portFree: async () => true,
      program: async (url) => {
        programCalls.push(url);
      },
      ...probes,
    },
  });
  const output = stdout + stderr;
  // No secret, home location or RPC path in any output.
  assert.equal(output.includes('FAKE0SECRET'), false, output);
  assert.equal(output.includes(fixture.home), false, output);
  return { code, output, programCalls };
}

const line = (output: string, check: string) =>
  output.split('\n').find((entry) => entry.trim().split(/\s+/)[1] === check);

void test('doctor: an empty home fails the role check with a setup hint and exits 1', async () => {
  const run = await fixture({ role: false });
  try {
    await withOllama(run);
    const result = await doctor(run);
    assert.equal(result.code, 1);
    assert.match(
      line(result.output, 'role') ?? '',
      /FAIL\s+role\s+ROLE_MISSING/,
    );
    assert.match(result.output, /pnpm node:setup --role seller/);
    assert.match(result.output, /NOT READY/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: a synthetic seller prints its public NodeId and owner and touches no file', async () => {
  const run = await fixture();
  try {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), FREE_TOML);
    const before = await listTree(run.root);
    const result = await doctor(run);
    assert.deepEqual(await listTree(run.root), before);
    assert.match(line(result.output, 'role') ?? '', /OK\s+role/);
    assert.match(line(result.output, 'keys') ?? '', /OK\s+keys/);
    assert.match(line(result.output, 'config') ?? '', /OK\s+config/);
    assert.match(line(result.output, 'ollama') ?? '', /OK\s+ollama/);
    assert.match(line(result.output, 'model') ?? '', /OK\s+model/);
    assert.match(line(result.output, 'relays') ?? '', /OK\s+relays/);
    assert.match(result.output, new RegExp(`nodeId\\s+${NODE_ID}`));
    assert.match(result.output, new RegExp(`owner\\s+${run.owner}`));
    assert.match(result.output, /offer\s+free qwen3-0\.6b/);
    // The pinned tokenizer is not present in a synthetic home.
    assert.match(
      line(result.output, 'tokenizer') ?? '',
      /FAIL\s+tokenizer\s+TOKENIZER_UNAVAILABLE/,
    );
    assert.match(result.output, /pnpm gate:inference:setup/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: key files readable by others fail the key check', async () => {
  const run = await fixture({ keyMode: 0o644 });
  try {
    await withOllama(run);
    const result = await doctor(run);
    assert.equal(result.code, 1);
    assert.match(
      line(result.output, 'keys') ?? '',
      /FAIL\s+keys\s+KEY_PERMISSIONS/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: config the daemon cannot honor reports the same startup code', async () => {
  const run = await fixture();
  try {
    await withOllama(run);
    await writeFile(
      join(run.root, 'gyblos.toml'),
      PAID_TOML.replace('input_per_mtok = "1"', 'input_per_mtok = "0.5"'),
    );
    const priced = await doctor(run);
    assert.match(
      line(priced.output, 'config') ?? '',
      /FAIL\s+config\s+SELLER_OFFER_PRICE_UNSUPPORTED/,
    );
    await writeFile(join(run.root, 'other.toml'), 'version = 1\n[node\n');
    const broken = await doctor(run, ['--config', 'other.toml']);
    assert.match(
      line(broken.output, 'config') ?? '',
      /FAIL\s+config\s+NODE_CONFIG_INVALID/,
    );
    const missing = await doctor(run, [], { GYBLOS_CONFIG: 'missing.toml' });
    assert.match(
      line(missing.output, 'config') ?? '',
      /FAIL\s+config\s+NODE_CONFIG_INVALID/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: a missing or malformed relay token fails without echoing it', async () => {
  const run = await fixture();
  try {
    await withOllama(run);
    const missing = await doctor(run, [], { GYBLOS_RELAY_TOKEN: '' });
    assert.match(
      line(missing.output, 'relays') ?? '',
      /FAIL\s+relays\s+MISSING_RELAY_TOKEN/,
    );
    const short = await doctor(run, [], { GYBLOS_RELAY_TOKEN: 'FAKE0SECRET' });
    assert.match(
      line(short.output, 'relays') ?? '',
      /FAIL\s+relays\s+INVALID_RELAY_TOKEN/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: engine checks fail for a missing ollama, an absent model and a busy port', async () => {
  const run = await fixture();
  try {
    const result = await doctor(run, [], {}, { portFree: async () => false });
    assert.match(
      line(result.output, 'ollama') ?? '',
      /FAIL\s+ollama\s+OLLAMA_NOT_FOUND/,
    );
    assert.match(
      line(result.output, 'model') ?? '',
      /WARN\s+model\s+MODEL_NOT_DOWNLOADED/,
    );
    assert.match(
      line(result.output, 'ports') ?? '',
      /FAIL\s+ports\s+PORT_IN_USE/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: --online checks the devnet program only for a paid offer and hides the RPC', async () => {
  const run = await fixture();
  try {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), FREE_TOML);
    const free = await doctor(run, ['--online']);
    assert.deepEqual(free.programCalls, []);
    assert.match(line(free.output, 'program') ?? '', /OK\s+program/);
    await writeFile(join(run.root, 'gyblos.toml'), PAID_TOML);
    const offline = await doctor(run);
    assert.deepEqual(offline.programCalls, []);
    assert.match(
      line(offline.output, 'program') ?? '',
      /WARN\s+program\s+ONLINE_CHECK_SKIPPED/,
    );
    const online = await doctor(run, ['--online']);
    assert.deepEqual(online.programCalls, [RPC_URL]);
    assert.match(line(online.output, 'program') ?? '', /OK\s+program/);
    const failing = await doctor(
      run,
      ['--online'],
      {},
      {
        program: async () => {
          throw new Error(`down ${FAKE_SECRET}`);
        },
      },
    );
    assert.match(
      line(failing.output, 'program') ?? '',
      /FAIL\s+program\s+DEVNET_PROGRAM_UNAVAILABLE/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

void test('doctor: the gyblos script entry sets exit code 1 for an empty home', () => {
  const home = join(tmpdir(), `gyblos-doctor-empty-${process.pid}`);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/node/src/cli.ts', 'doctor'],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        GYBLOS_HOME: home,
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /ROLE_MISSING/);
});
