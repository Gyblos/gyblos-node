// Owns `gyblos seller rpc`: it shows, sets or resets the Solana RPC the seller reads from its role file at
// startup. The URL comes from GYBLOS_RPC_URL or a terminal question, never a flag or argument, because
// providers embed API keys in it; output shows only the origin. A URL is saved only after it answers as
// devnet, every other role field and key file stays untouched, and the seller must restart to use it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

for (const value of ['', 'ftp://devnet.example-rpc.com', 'not a url'])
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

void test('seller rpc reset: goes back to the public devnet RPC', () =>
  withHome(async (home) => {
    const result = await rpc(home, ['reset'], { genesis: devnet });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await role(home)).rpcUrl, DEVNET_RPC_URL);
    assert.match(result.stdout, /restart/i);
  }));

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
