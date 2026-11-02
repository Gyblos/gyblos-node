// Synthetic seller homes for the `gyblos doctor` tests: generated public addresses, empty fake key files
// with chosen modes, an optional synthetic Ollama on loopback, and a runner that asserts no secret is printed.
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

import { startFakeOllama } from './fake-ollama';
import { FAKE_SECRET } from './node-config-fixtures';

export const NODE_ID = 'ab'.repeat(32);
const RELAY_TOKEN = `${FAKE_SECRET}-relay-token`;
export const RPC_URL = `https://rpc.example.com/v2/${FAKE_SECRET}`;
export const KEY_FILES = [
  'owner.json',
  'authorizer.json',
  'facilitator.json',
  'node.key',
];
const FREE = 'free = { daily_token_cap = 20000, per_buyer_cap = 2000 }';
// The fixture's free offer at its engine URL: the synthetic Ollama once withOllama ran.
export const freeToml = (run: Fixture) =>
  `version = 1\n[node]\nnetwork = "devnet"\n[[offers]]\nmodel = "qwen3:0.6b"\nreasoning = ["off"]\nengine = { kind = "ollama", url = "${run.engineUrl}" }\n${FREE}\n`;
export const paidToml = (run: Fixture) =>
  freeToml(run).replace(
    FREE,
    'price = { input_per_mtok = "1", output_per_mtok = "2", currency = "USDC" }',
  );
// A free offer on a remote OpenAI-compatible engine (a custom model), with its key in UPSTREAM_API_KEY.
export const REMOTE_FREE =
  'version = 1\n[node]\nnetwork = "devnet"\n[[offers]]\nmodel = "acme/chat-small"\ncustom = true\nreasoning = ["off"]\nengine = { kind = "openai", url = "https://api.example.com/v1", api_key_env = "UPSTREAM_API_KEY", context_tokens = 131072 }\nfree = { daily_token_cap = 20000, per_buyer_cap = 2000 }\n';

const ALL_OK = {
  tokenizer: async () => undefined,
  paymentAccounts: async () => 0,
} satisfies NonNullable<CliContext['doctor']>;

export interface Fixture {
  root: string;
  home: string;
  seller: string;
  owner: string;
  engineUrl: string;
  cleanup: (() => Promise<void>)[];
}

export async function fixture(
  options: {
    role?: 'seller' | 'buyer' | false;
    keyMode?: number;
    // A free seller's role file, as `node:setup` writes it without --buyer/--pay-to.
    free?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-doctor-'));
  const home = join(root, 'home');
  const seller = join(home, 'seller');
  await mkdir(seller, { recursive: true, mode: 0o700 });
  await chmod(seller, 0o700);
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
    };
    await writeFile(
      join(seller, 'role.json'),
      JSON.stringify(
        role === 'buyer'
          ? { ...common, buyer }
          : options.free
            ? { ...common, owner }
            : { ...common, owner, authorizer, facilitator, payTo, buyer },
      ),
    );
    for (const name of KEY_FILES) {
      // Never real key material: doctor only checks file metadata.
      await writeFile(join(seller, name), '[]');
      await chmod(join(seller, name), options.keyMode ?? 0o600);
    }
  }
  return {
    root,
    home,
    seller,
    owner: owner!,
    // A just-closed ephemeral port: an offer here has a stopped engine until withOllama runs.
    engineUrl: await stoppedEngineUrl(),
    cleanup: [],
  };
}

async function stoppedEngineUrl() {
  const ollama = await startFakeOllama();
  await ollama.close();
  return ollama.url;
}

// Serves the pinned model on an ephemeral loopback port and points the fixture's offers at it.
export async function withOllama(
  fixture: Fixture,
  options: Parameters<typeof startFakeOllama>[0] = {},
) {
  const ollama = await startFakeOllama(options);
  fixture.engineUrl = ollama.url;
  fixture.cleanup.push(ollama.close);
  return ollama;
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
  const code = await runCli(['doctor', ...args], {
    env: {
      GYBLOS_HOME: fixture.home,
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
    doctor: { ...ALL_OK, ...probes },
  });
  const output = stdout + stderr;
  // No secret, home location or RPC path in any output.
  assert.equal(output.includes('FAKE0SECRET'), false, output);
  assert.equal(output.includes(fixture.home), false, output);
  return { code, output };
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
    for (const close of run.cleanup) await close();
    await rm(run.root, { recursive: true, force: true });
  }
}
