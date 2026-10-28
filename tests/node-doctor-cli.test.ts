// Owns the `gyblos doctor` contract for the seller: read-only checks with static codes, the public
// NodeId/owner summary, exit codes 0/1 and no secret, home path or RPC path in any output.
// Offline; synthetic role files in a temporary home, an injected tokenizer probe and a synthetic Ollama
// on an ephemeral loopback port.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';

import {
  doctor,
  freeToml,
  KEY_FILES,
  line,
  NODE_ID,
  paidToml,
  scenario,
  snapshot,
  withOllama,
} from './support/doctor-fixture';
import { FAKE_SECRET, REPOSITORY_ROOT } from './support/node-config-fixtures';

void test('doctor: a ready free seller exits 0, prints its public identity and changes nothing', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
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
      'engine[1]',
      'relays',
    ])
      assert.match(line(result.output, check), /^\s*OK\s/, check);
    // Paid v1 selling is off, so there is no devnet program to check.
    assert.doesNotMatch(result.output, /program/);
    assert.match(result.output, new RegExp(`nodeId\\s+${NODE_ID}`));
    assert.match(result.output, new RegExp(`owner\\s+${run.owner}`));
    assert.match(result.output, /offer\[1\] free qwen3-0\.6b/);
    assert.match(result.output, /publish\s+off/);
    assert.match(result.output, /connections 8 total/);
    assert.match(result.output, /requests\s+30\/min per buyer, 256\/min total/);
    assert.match(result.output, /free buyers 1024\/day across all offers/);
  }));

void test('doctor: prints the [limits] the seller will serve with', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(
      join(run.root, 'gyblos.toml'),
      `${freeToml(run)}\n[limits]\nrequests_per_minute = 60\nglobal_requests_per_minute = 512\n`,
    );
    const result = await doctor(run);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /connections 8 total/);
    assert.match(result.output, /requests\s+60\/min per buyer, 512\/min total/);
    await writeFile(
      join(run.root, 'gyblos.toml'),
      `${freeToml(run)}\n[limits]\nrequests_per_minute = 60\n`,
    );
    const invalid = await doctor(run);
    assert.equal(invalid.code, 1);
    assert.match(invalid.output, /INVALID_LIMIT\s+limits\.requests_per_minute/);
    assert.doesNotMatch(invalid.output, /Limits/);
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
    // The paid authorizer and facilitator keys are never needed.
    await unlink(join(run.seller, 'facilitator.json'));
    await unlink(join(run.seller, 'authorizer.json'));
    for (const toml of [freeToml(run), paidToml(run)]) {
      await writeFile(join(run.root, 'gyblos.toml'), toml);
      assert.match(line((await doctor(run)).output, 'keys'), /OK\s+keys/);
    }
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
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
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    const paid = await doctor(run);
    assert.equal(paid.code, 1);
    assert.match(
      line(paid.output, 'config'),
      /FAIL\s+config\s+SELLER_PAID_EXECUTION_UNAVAILABLE\s+\[\[offers\]\] entry 1: /,
    );
    // A refused offer still leaves the relay settings checked.
    assert.match(line(paid.output, 'relays'), /^\s*OK\s+relays/);
    await unlink(join(run.root, 'gyblos.toml'));
    const none = await doctor(run);
    assert.equal(none.code, 1);
    assert.match(
      line(none.output, 'config'),
      /FAIL\s+config\s+SELLER_OFFERS_MISSING/,
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
      `${freeToml(run)}[discovery]\npublish = true\nurl = "https://discovery.example.com/v1/${FAKE_SECRET}"\n`,
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
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
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

void test('doctor: a stopped engine at the offer URL fails with the engine code; no tokenizer fails too', () =>
  scenario({}, async (run) => {
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
    const stopped = await doctor(run, [], {}, { tokenizer: undefined });
    assert.equal(stopped.code, 1);
    assert.match(
      line(stopped.output, 'engine[1]'),
      /FAIL\s+engine\[1\]\s+ENGINE_UNAVAILABLE\s+start the engine at the offer URL/,
    );
    assert.match(
      line(stopped.output, 'tokenizer'),
      /FAIL\s+tokenizer\s+TOKENIZER_UNAVAILABLE/,
    );
    assert.match(stopped.output, /pnpm gate:inference:setup/);
    // The engine is checked by describing it only: the model list, never a generation.
    const ollama = await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
    const ready = await doctor(run);
    assert.match(line(ready.output, 'engine[1]'), /^\s*OK\s+engine\[1\]/);
    assert.deepEqual([...new Set(ollama.paths)], ['/api/tags']);
  }));

void test('doctor: an engine that never answers fails with ENGINE_TIMEOUT within its deadline', () =>
  scenario({}, async (run) => {
    await withOllama(run, { hang: true });
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
    const hung = await doctor(run);
    assert.equal(hung.code, 1);
    assert.match(
      line(hung.output, 'engine[1]'),
      /FAIL\s+engine\[1\]\s+ENGINE_TIMEOUT\s+the engine at the offer URL/,
    );
  }));

void test('doctor: an offer the daemon refuses leaves the engine unchecked, and doctor takes no --online', () =>
  scenario({}, async (run) => {
    const ollama = await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    const paid = await doctor(run);
    assert.match(line(paid.output, 'engine'), /WARN\s+engine\s+NOT_CHECKED/);
    assert.deepEqual(ollama.paths, []);
    for (const removed of ['ollama', 'model', 'ports'])
      assert.equal(line(paid.output, removed), '', removed);
    const online = await doctor(run, ['--online']);
    assert.equal(online.code, 1);
    assert.match(online.output, /Usage:/);
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
