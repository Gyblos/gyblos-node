// Synthetic seller homes for the `gyblos doctor` tests: generated public addresses, empty fake key files
// with chosen modes, a fake `ollama` and model manifest, and a runner that asserts no secret is printed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPairSigner } from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { runCli, type CliContext } from '@gyblos/node-app/cli';

import { FAKE_SECRET } from './node-config-fixtures.js';

export const NODE_ID = 'ab'.repeat(32);
const RELAY_TOKEN = `${FAKE_SECRET}-relay-token`;
export const RPC_URL = `https://rpc.example.com/v2/${FAKE_SECRET}`;
export const KEY_FILES = [
  'owner.json',
  'authorizer.json',
  'facilitator.json',
  'node.key',
];
const MANAGED = '{ kind = "ollama", url = "http://127.0.0.1:11436" }';
export const FREE_TOML = `version = 1\n[node]\nnetwork = "devnet"\n[[offers]]\nmodel = "qwen3:0.6b"\nreasoning = ["off"]\nengine = ${MANAGED}\nfree = { daily_token_cap = 20000, per_buyer_cap = 2000 }\n`;
export const PAID_TOML = FREE_TOML.replace(
  'free = { daily_token_cap = 20000, per_buyer_cap = 2000 }',
  'price = { input_per_mtok = "1", output_per_mtok = "2", currency = "USDC" }',
);
const ALL_OK = {
  portFree: async () => true,
  tokenizer: async () => undefined,
} satisfies NonNullable<CliContext['doctor']>;

export interface Fixture {
  root: string;
  home: string;
  seller: string;
  bin: string;
  owner: string;
}

export async function fixture(
  options: { role?: 'seller' | 'buyer' | false; keyMode?: number } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-doctor-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const seller = join(home, 'seller');
  await mkdir(seller, { recursive: true, mode: 0o700 });
  await chmod(seller, 0o700);
  await mkdir(bin);
  const [owner, authorizer, facilitator, payTo, buyer, mint] =
    await Promise.all(
      Array.from(
        { length: 6 },
        async () => (await generateKeyPairSigner()).address,
      ),
    );
  const role = options.role ?? 'seller';
  if (role) {
    const common = {
      schemaVersion: 1,
      role,
      rpcUrl: RPC_URL,
      mint,
      assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
      nodeId: NODE_ID,
      buyer,
    };
    await writeFile(
      join(seller, 'role.json'),
      JSON.stringify(
        role === 'seller'
          ? { ...common, owner, authorizer, facilitator, payTo }
          : common,
      ),
    );
    for (const name of KEY_FILES) {
      // Never real key material: doctor only checks file metadata.
      await writeFile(join(seller, name), '[]');
      await chmod(join(seller, name), options.keyMode ?? 0o600);
    }
  }
  return { root, home, seller, bin, owner: owner! };
}

export async function withOllama(fixture: Fixture) {
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

// Path, mode and content of every entry: doctor must not change any of them.
export async function snapshot(directory: string) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
      .map(async (path) => {
        const info = await stat(path);
        const digest = info.isFile()
          ? createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          : '';
        return `${path} ${info.mode} ${digest}`;
      }),
  );
}

export async function doctor(
  fixture: Fixture,
  args: string[] = [],
  env: Record<string, string> = {},
  probes: NonNullable<CliContext['doctor']> = {},
) {
  let stdout = '';
  let stderr = '';
  const programCalls: string[] = [];
  const probed: string[] = [];
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
      ...ALL_OK,
      portFree: async (url) => {
        probed.push(url);
        return true;
      },
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
  return { code, output, programCalls, probed };
}

export const line = (output: string, check: string) =>
  output.split('\n').find((entry) => entry.trim().split(/\s+/)[1] === check) ??
  '';

export async function scenario(
  options: Parameters<typeof fixture>[0],
  use: (run: Fixture) => Promise<void>,
) {
  const run = await fixture(options);
  try {
    await use(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
}
