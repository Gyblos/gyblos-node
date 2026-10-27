// Owns the `gyblos doctor` contract for the seller: read-only checks with static codes, the public
// NodeId/owner summary, exit codes 0/1 and no secret, home path or RPC path in any output.
// Offline; synthetic role files in a temporary home, injected port, tokenizer and program probes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';

import {
  doctor,
  FREE_TOML,
  KEY_FILES,
  line,
  NODE_ID,
  PAID_TOML,
  RPC_URL,
  scenario,
  snapshot,
  withOllama,
} from './support/doctor-fixture.js';
import {
  FAKE_SECRET,
  REPOSITORY_ROOT,
} from './support/node-config-fixtures.js';

void test('doctor: a ready free seller exits 0, prints its public identity and changes nothing', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), FREE_TOML);
    const before = await snapshot(run.root);
    const result = await doctor(run);
    assert.deepEqual(await snapshot(run.root), before);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Result: READY/);
    for (const check of [
      'config',
      'home',
      'role',
      'keys',
      'sequence',
      'tokenizer',
      'ollama',
      'model',
      'ports',
      'relays',
    ])
      assert.match(line(result.output, check), /^\s*OK\s/, check);
    assert.match(line(result.output, 'program'), /OK\s+program\s+NOT_NEEDED/);
    assert.match(result.output, new RegExp(`nodeId\\s+${NODE_ID}`));
    assert.match(result.output, new RegExp(`owner\\s+${run.owner}`));
    assert.match(result.output, /offer\s+free qwen3-0\.6b/);
    assert.match(result.output, /publish\s+off/);
    assert.match(result.output, /connections 8 total, 1 per buyer/);
    assert.match(result.output, /requests\s+30\/min per buyer, 256\/min total/);
    assert.match(result.output, /free buyers 1024\/day/);
  }));

void test('doctor: prints the [limits] the seller will serve with', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(
      join(run.root, 'gyblos.toml'),
      `${FREE_TOML}\n[limits]\nmax_connections = 16\nrequests_per_minute = 60\n`,
    );
    const result = await doctor(run);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /connections 16 total, 1 per buyer/);
    assert.match(result.output, /requests\s+60\/min per buyer, 256\/min total/);
  }));

void test('doctor: an empty home fails the role check with a setup hint and exits 1', () =>
  scenario({ role: false }, async (run) => {
    await withOllama(run);
    const result = await doctor(run);
    assert.equal(result.code, 1);
    assert.match(line(result.output, 'role'), /FAIL\s+role\s+ROLE_MISSING/);
    assert.match(line(result.output, 'keys'), /WARN\s+keys\s+NOT_CHECKED/);
    assert.match(result.output, /pnpm node:setup --role seller/);
    assert.match(result.output, /NOT READY/);
  }));

void test('doctor: a buyer role in the seller home is refused', () =>
  scenario({ role: 'buyer' }, async (run) => {
    await withOllama(run);
    const result = await doctor(run);
    assert.match(line(result.output, 'role'), /FAIL\s+role\s+ROLE_NOT_SELLER/);
  }));

void test('doctor: key files must be private regular files; free sellers need only owner and node keys', () =>
  scenario({ keyMode: 0o644 }, async (run) => {
    await withOllama(run);
    const loose = await doctor(run);
    assert.equal(loose.code, 1);
    assert.match(line(loose.output, 'keys'), /FAIL\s+keys\s+KEY_PERMISSIONS/);
    for (const name of KEY_FILES) await chmod(join(run.seller, name), 0o600);
    await unlink(join(run.seller, 'owner.json'));
    await mkdir(join(run.seller, 'owner.json'), { mode: 0o600 });
    await chmod(join(run.seller, 'owner.json'), 0o600);
    const directory = await doctor(run);
    assert.match(
      line(directory.output, 'keys'),
      /FAIL\s+keys\s+KEY_PERMISSIONS/,
    );
    await rm(join(run.seller, 'owner.json'), { recursive: true });
    await writeFile(join(run.seller, 'owner.json'), '[]', { mode: 0o600 });
    await unlink(join(run.seller, 'facilitator.json'));
    await writeFile(join(run.root, 'gyblos.toml'), PAID_TOML);
    const paid = await doctor(run);
    assert.match(line(paid.output, 'keys'), /FAIL\s+keys\s+KEYS_MISSING/);
    await writeFile(join(run.seller, 'facilitator.json'), '[]', {
      mode: 0o600,
    });
    await unlink(join(run.seller, 'authorizer.json'));
    const noAuthorizer = await doctor(run);
    assert.match(
      line(noAuthorizer.output, 'keys'),
      /FAIL\s+keys\s+KEYS_MISSING/,
    );
    await writeFile(join(run.root, 'gyblos.toml'), FREE_TOML);
    const free = await doctor(run);
    assert.match(line(free.output, 'keys'), /OK\s+keys/);
    await unlink(join(run.seller, 'node.key'));
    const noNodeKey = await doctor(run);
    assert.match(line(noNodeKey.output, 'keys'), /FAIL\s+keys\s+KEYS_MISSING/);
  }));

void test('doctor: an unsafe seller directory or leftover sequence lock is reported like startup', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await chmod(run.seller, 0o755);
    const open = await doctor(run);
    assert.match(
      line(open.output, 'sequence'),
      /FAIL\s+sequence\s+PUBLIC_SEQUENCE_UNAVAILABLE/,
    );
    await chmod(run.seller, 0o700);
    await writeFile(join(run.seller, 'public-sequence-v2.lock'), '');
    const locked = await doctor(run);
    assert.match(
      line(locked.output, 'sequence'),
      /FAIL\s+sequence\s+SEQUENCE_LOCK_PRESENT/,
    );
    assert.equal(locked.code, 1);
    await rm(join(run.seller, 'public-sequence-v2.lock'));
    await writeFile(
      join(run.seller, 'public-sequence-v2.json'),
      JSON.stringify({
        schemaVersion: 1,
        recordVersion: 2,
        nodeId: 'cd'.repeat(32),
        highWater: 1,
      }),
      { mode: 0o600 },
    );
    const foreign = await doctor(run);
    assert.match(
      line(foreign.output, 'sequence'),
      /FAIL\s+sequence\s+PUBLIC_SEQUENCE_UNAVAILABLE/,
    );
  }));

void test('doctor: config the daemon cannot honor reports the same startup code and file issues', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(
      join(run.root, 'gyblos.toml'),
      PAID_TOML.replace('input_per_mtok = "1"', 'input_per_mtok = "0.5"'),
    );
    const priced = await doctor(run);
    assert.match(
      line(priced.output, 'config'),
      /FAIL\s+config\s+SELLER_OFFER_PRICE_UNSUPPORTED/,
    );
    await writeFile(join(run.root, 'other.toml'), 'version = 1\n[node\n');
    const broken = await doctor(run, [], { GYBLOS_CONFIG: 'other.toml' });
    assert.match(
      line(broken.output, 'config'),
      /FAIL\s+config\s+NODE_CONFIG_INVALID/,
    );
    assert.match(broken.output, /TOML_SYNTAX/);
    const missing = await doctor(run, [], { GYBLOS_CONFIG: 'missing.toml' });
    assert.match(
      line(missing.output, 'config'),
      /FAIL\s+config\s+NODE_CONFIG_INVALID/,
    );
    await writeFile(
      join(run.root, 'gyblos.toml'),
      `${FREE_TOML}[discovery]\npublish = true\nurl = "https://discovery.example.com/v1/${FAKE_SECRET}"\n`,
    );
    const published = await doctor(run);
    assert.match(
      published.output,
      /publish\s+https:\/\/discovery\.example\.com <path hidden>/,
    );
  }));

void test('doctor: a missing or malformed relay token fails without echoing it', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    const missing = await doctor(run, [], { GYBLOS_RELAY_TOKEN: '' });
    assert.match(
      line(missing.output, 'relays'),
      /FAIL\s+relays\s+MISSING_RELAY_TOKEN/,
    );
    const short = await doctor(run, [], {
      GYBLOS_RELAY_TOKEN: 'FAKE0SECRET',
    });
    assert.match(
      line(short.output, 'relays'),
      /FAIL\s+relays\s+INVALID_RELAY_TOKEN_LENGTH/,
    );
  }));

void test('doctor: engine checks fail without ollama, tokenizer or model, and on a busy port', () =>
  scenario({}, async (run) => {
    const nothing = await doctor(
      run,
      [],
      {},
      { portFree: async () => false, tokenizer: undefined },
    );
    assert.match(
      line(nothing.output, 'ollama'),
      /FAIL\s+ollama\s+OLLAMA_NOT_FOUND/,
    );
    assert.match(
      line(nothing.output, 'model'),
      /FAIL\s+model\s+MODEL_NOT_DOWNLOADED/,
    );
    assert.match(line(nothing.output, 'ports'), /FAIL\s+ports\s+PORT_IN_USE/);
    assert.match(
      line(nothing.output, 'tokenizer'),
      /FAIL\s+tokenizer\s+TOKENIZER_UNAVAILABLE/,
    );
    assert.match(nothing.output, /pnpm gate:inference:setup/);
    // Present but not executable, or a directory: neither is runnable.
    await writeFile(join(run.bin, 'ollama'), '');
    await chmod(join(run.bin, 'ollama'), 0o644);
    const plain = await doctor(run);
    assert.match(
      line(plain.output, 'ollama'),
      /FAIL\s+ollama\s+OLLAMA_NOT_FOUND/,
    );
    await rm(join(run.bin, 'ollama'));
    await mkdir(join(run.bin, 'ollama'), { mode: 0o755 });
    const folder = await doctor(run);
    assert.match(
      line(folder.output, 'ollama'),
      /FAIL\s+ollama\s+OLLAMA_NOT_FOUND/,
    );
  }));

void test('doctor: probes the paid ports only for a paid offer', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), FREE_TOML);
    const free = await doctor(run);
    assert.deepEqual(
      free.probed.map((url) => new URL(url).port),
      ['11436'],
    );
    await writeFile(join(run.root, 'gyblos.toml'), PAID_TOML);
    const paid = await doctor(run);
    assert.deepEqual(
      paid.probed.map((url) => new URL(url).port),
      ['11436', '4022', '4032'],
    );
  }));

void test('doctor: --online checks the devnet program only for a paid offer and hides the RPC', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), FREE_TOML);
    const free = await doctor(run, ['--online']);
    assert.deepEqual(free.programCalls, []);
    assert.match(line(free.output, 'program'), /OK\s+program/);
    await writeFile(join(run.root, 'gyblos.toml'), PAID_TOML);
    const offline = await doctor(run);
    assert.deepEqual(offline.programCalls, []);
    assert.match(
      line(offline.output, 'program'),
      /WARN\s+program\s+ONLINE_CHECK_SKIPPED/,
    );
    assert.equal(offline.code, 0, 'a warning alone is not a failure');
    const online = await doctor(run, ['--online']);
    assert.deepEqual(online.programCalls, [RPC_URL]);
    assert.match(line(online.output, 'program'), /OK\s+program/);
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
      line(failing.output, 'program'),
      /FAIL\s+program\s+DEVNET_PROGRAM_UNAVAILABLE/,
    );
  }));

void test('doctor and config validate refuse arguments they do not take', () =>
  scenario({}, async (run) => {
    for (const args of [['--config', 'gyblos.toml'], ['extra'], ['--bogus']]) {
      const result = await doctor(run, args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.output, /Usage:/);
    }
    let stderr = '';
    const code = await runCli(['config', 'validate', '--online'], {
      env: {},
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });
    assert.equal(code, 1);
    assert.match(stderr, /Usage:/);
  }));

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
