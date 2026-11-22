// Owns `gyblos seller rpc`: it shows, sets or resets the Solana RPC the seller reads from its role file at
// startup. The URL comes from GYBLOS_RPC_URL or a terminal question, never a flag or argument, because
// providers embed API keys in it; output shows only the origin. A URL is saved only after it answers as
// devnet, every other role field and key file stays untouched, and the seller must restart to use it.
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET_GENESIS, DEVNET_RPC_URL } from '@gyblos/config';

import { runCli } from '../apps/node/src/cli';
import { snapshot } from './support/doctor-fixture';
import { withHome, type Home } from './support/status-fixture';

const PRIVATE = 'https://devnet.example-rpc.com/v2/?api-key=secret-key-1234';
const ORIGIN = 'https://devnet.example-rpc.com';

async function rpc(
  home: Home,
  args: string[],
  options: {
    env?: Record<string, string>;
    prompt?: (question: string) => Promise<string>;
    genesis?: (url: string) => Promise<string>;
  } = {},
) {
  const asked: string[] = [];
  let stdout = '';
  let stderr = '';
  const code = await runCli(['seller', 'rpc', ...args], {
    env: { GYBLOS_HOME: home.home, ...options.env },
    cwd: home.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: options.prompt,
    genesis: async (url) => {
      asked.push(url);
      if (!options.genesis) throw new Error('no network in this test');
      return options.genesis(url);
    },
  });
  const output = stdout + stderr;
  assert.equal(output.includes('secret-key-1234'), false, output);
  assert.equal(output.includes(home.home), false, output);
  return { code, stdout, stderr, asked };
}
const role = async (home: Home) =>
  JSON.parse(await readFile(join(home.seller, 'role.json'), 'utf8')) as Record<
    string,
    unknown
  >;
const devnet = async () => DEVNET_GENESIS;

void test('seller rpc: shows only the origin of the RPC in the role file', () =>
  withHome(async (home) => {
    const result = await rpc(home, []);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /https:\/\/rpc\.example\.com/);
    assert.deepEqual(result.asked, []);
  }));

void test('seller rpc set: saves a devnet URL from GYBLOS_RPC_URL, keeps every other field and says to restart', () =>
  withHome(async (home) => {
    const before = await role(home);
    const result = await rpc(home, ['set'], {
      env: { GYBLOS_RPC_URL: PRIVATE },
      genesis: devnet,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.asked, [PRIVATE]);
    assert.deepEqual(await role(home), { ...before, rpcUrl: PRIVATE });
    assert.match(result.stdout, new RegExp(ORIGIN.replaceAll('.', '\\.')));
    assert.match(result.stdout, /restart/i);
  }));

void test('seller rpc set: asks on a terminal when GYBLOS_RPC_URL is unset', () =>
  withHome(async (home) => {
    const questions: string[] = [];
    const result = await rpc(home, ['set'], {
      prompt: async (question) => {
        questions.push(question);
        return `  ${PRIVATE}  `;
      },
      genesis: devnet,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(questions.length, 1);
    assert.equal((await role(home)).rpcUrl, PRIVATE);
  }));

void test('seller rpc set: refuses a URL on the command line and writes nothing', () =>
  withHome(async (home) => {
    const before = await snapshot(home.root);
    const result = await rpc(home, ['set', PRIVATE], { genesis: devnet });
    assert.equal(result.code, 1);
    assert.deepEqual(result.asked, []);
    assert.deepEqual(await snapshot(home.root), before);
  }));

for (const [name, genesis] of [
  ['another network', async () => 'mainnet-genesis-hash'],
  [
    'an RPC that does not answer',
    async () => {
      throw new Error('fetch failed: https://devnet.example-rpc.com');
    },
  ],
] as const)
  void test(`seller rpc set: refuses ${name} and writes nothing`, () =>
    withHome(async (home) => {
      const before = await snapshot(home.root);
      const result = await rpc(home, ['set'], {
        env: { GYBLOS_RPC_URL: PRIVATE },
        genesis,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /devnet/i);
      assert.deepEqual(await snapshot(home.root), before);
    }));

for (const value of [
  '',
  'ftp://devnet.example-rpc.com',
  'not a url',
  'http://devnet.example-rpc.com/?api-key=secret-key-1234',
])
  void test(`seller rpc set: refuses ${JSON.stringify(value)} before any request`, () =>
    withHome(async (home) => {
      const before = await snapshot(home.root);
      const result = await rpc(home, ['set'], {
        env: { GYBLOS_RPC_URL: value },
        genesis: devnet,
      });
      assert.equal(result.code, 1);
      assert.deepEqual(result.asked, []);
      assert.deepEqual(await snapshot(home.root), before);
    }));

void test('seller rpc set: without GYBLOS_RPC_URL or a terminal it says how to give one', () =>
  withHome(async (home) => {
    const result = await rpc(home, ['set'], { genesis: devnet });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GYBLOS_RPC_URL/);
  }));

void test('seller rpc reset: goes back to the public devnet RPC without reaching it', () =>
  withHome(async (home) => {
    const before = await role(home);
    const result = await rpc(home, ['reset']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.asked, []);
    assert.deepEqual(await role(home), { ...before, rpcUrl: DEVNET_RPC_URL });
    assert.match(result.stdout, /restart/i);
    const shown = await rpc(home, []);
    assert.match(shown.stdout, /public devnet RPC/);
  }));

void test('seller rpc set: a terminal is always asked, so a stale GYBLOS_RPC_URL never comes back; its question never echoes a URL', () =>
  withHome(async (home) => {
    const questions: string[] = [];
    const asked = await rpc(home, ['set'], {
      env: { GYBLOS_RPC_URL: 'https://stale.example-rpc.com' },
      prompt: async (question) => {
        questions.push(question);
        return PRIVATE;
      },
      genesis: devnet,
    });
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.includes('example-rpc'), false);
    assert.equal((await role(home)).rpcUrl, PRIVATE);
  }));

void test('seller rpc: an unknown subcommand prints usage and writes nothing', () =>
  withHome(async (home) => {
    const before = await snapshot(home.root);
    const result = await rpc(home, ['change']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: gyblos seller rpc/);
    assert.deepEqual(await snapshot(home.root), before);
  }));

void test('seller rpc: showing without a seller role fails', () =>
  withHome(
    async (home) => {
      const result = await rpc(home, []);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /no seller/);
    },
    { role: false },
  ));

void test('seller rpc: a home without a seller role is refused and nothing is created', () =>
  withHome(
    async (home) => {
      const before = await snapshot(home.root);
      const result = await rpc(home, ['set'], {
        env: { GYBLOS_RPC_URL: PRIVATE },
        genesis: devnet,
      });
      assert.equal(result.code, 1);
      assert.deepEqual(await snapshot(home.root), before);
    },
    { role: false },
  ));

void test('seller rpc set: plain http is accepted on this computer', () =>
  withHome(async (home) => {
    const result = await rpc(home, ['set'], {
      env: { GYBLOS_RPC_URL: 'http://127.0.0.1:8899' },
      genesis: devnet,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await role(home)).rpcUrl, 'http://127.0.0.1:8899');
  }));

void test('seller rpc: --help prints usage and succeeds', () =>
  withHome(async (home) => {
    const result = await rpc(home, ['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: gyblos seller rpc/);
  }));

void test('seller rpc: an unreadable role file is not reported as a missing seller', () =>
  withHome(async (home) => {
    await writeFile(join(home.seller, 'role.json'), '{ not json');
    const result = await rpc(home, []);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot be read/);
  }));

void test('seller rpc set: in a script, a GYBLOS_RPC_URL equal to the saved RPC (however spelled) is stale', () =>
  withHome(async (home) => {
    const scripted = await rpc(home, ['set'], {
      env: { GYBLOS_RPC_URL: 'https://RPC.example.com/' },
      genesis: devnet,
    });
    assert.equal(scripted.code, 1);
    assert.match(scripted.stderr, /already uses/);
    assert.deepEqual(scripted.asked, []);
  }));

void test('seller rpc: restart advice keeps the installed service, never uninstalling it', () =>
  withHome(async (home) => {
    const result = await rpc(home, ['reset']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(/uninstall/.test(result.stdout), false, result.stdout);
    assert.match(result.stdout, /gyblos seller service restart/);
  }));

void test('seller rpc: only rpcUrl changes in role.json; a legacy buyer field is kept as written', () =>
  withHome(async (home) => {
    const path = join(home.seller, 'role.json');
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    const legacy = {
      ...original,
      authorizer: 'So11111111111111111111111111111111111111112',
      facilitator: 'SysvarRent111111111111111111111111111111111',
      payTo: 'SysvarC1ock11111111111111111111111111111111',
      buyer: 'Vote111111111111111111111111111111111111111',
    };
    await writeFile(path, JSON.stringify(legacy));
    const result = await rpc(home, ['reset']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await role(home), { ...legacy, rpcUrl: DEVNET_RPC_URL });
  }));

void test(
  'seller rpc: a role that cannot be written fails without printing private paths',
  {
    // Windows ignores the directory mode and root bypasses it.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  () =>
    withHome(async (home) => {
      await chmod(home.seller, 0o500);
      try {
        const result = await rpc(home, ['reset']);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /cannot be written/);
      } finally {
        await chmod(home.seller, 0o700);
      }
    }),
);
