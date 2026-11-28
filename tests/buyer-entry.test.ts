import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BUYER_ROUTES, run, type BuyerRoutes } from '@gyblos/buyer-app/entry';
import { BUYER_COMMANDS } from '@gyblos/buyer/constants';

const COMMANDS = Object.values(BUYER_COMMANDS);

function capture() {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(text: string) {
        lines.push(text);
        return true;
      },
    },
  };
}

function recorder() {
  const calls: { command: string; args: readonly string[] }[] = [];
  const routes = Object.fromEntries(
    COMMANDS.map((command) => [
      command,
      async (args: readonly string[]) => {
        calls.push({ command, args });
      },
    ]),
  ) as BuyerRoutes;
  return { calls, routes };
}

void test('every buyer subcommand reaches its own route with the remaining arguments', async () => {
  for (const command of COMMANDS) {
    const { calls, routes } = recorder();
    const out = capture();
    const err = capture();
    const code = await run([command, '--flag', 'value'], routes, {
      out: out.stream,
      err: err.stream,
    });
    assert.equal(code, undefined);
    assert.deepEqual(calls, [{ command, args: ['--flag', 'value'] }]);
    assert.deepEqual([out.lines, err.lines], [[], []]);
  }
});

void test('a missing, unknown or inherited command prints the usage and runs nothing', async () => {
  for (const args of [[], ['nope'], ['toString'], ['constructor', 'start']]) {
    const { calls, routes } = recorder();
    const out = capture();
    const err = capture();
    const code = await run(args, routes, { out: out.stream, err: err.stream });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(out.lines, []);
    assert.equal(err.lines.length, 1);
    for (const command of COMMANDS)
      assert.match(err.lines[0]!, new RegExp(`\\b${command}\\b`));
  }
});

void test('--help and -h print the usage on standard output and succeed', async () => {
  for (const flag of ['--help', '-h']) {
    const { calls, routes } = recorder();
    const out = capture();
    const err = capture();
    const code = await run([flag], routes, {
      out: out.stream,
      err: err.stream,
    });
    assert.equal(code, undefined);
    assert.deepEqual(calls, []);
    assert.deepEqual(err.lines, []);
    assert.equal(out.lines.length, 1);
    for (const command of COMMANDS)
      assert.match(out.lines[0]!, new RegExp(`\\b${command}\\b`));
  }
});

void test('the buyer routes cover exactly the declared commands', () => {
  assert.deepEqual(Object.keys(BUYER_ROUTES).sort(), [...COMMANDS].sort());
});

void test('the buyer executable runs each subcommand and keeps its exit code and messages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-buyer-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = new URL('../apps/buyer/src/bin.ts', import.meta.url)
    .pathname;
  const spawn = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), executable, ...args],
      {
        cwd: directory,
        env: { ...process.env, GYBLOS_HOME: directory },
        encoding: 'utf8',
      },
    );
  const auto = spawn(BUYER_COMMANDS.AUTO);
  assert.equal(auto.status, 1);
  assert.match(auto.stderr, /^Usage: pnpm buyer:auto /);
  assert.equal(spawn(BUYER_COMMANDS.AUTO, '-1', '1').status, 1);
  const help = spawn(BUYER_COMMANDS.INIT, '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: pnpm buyer:init /);
  const invalid = spawn(BUYER_COMMANDS.INIT, '--nope');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^Usage: pnpm buyer:init /);
  const agent = spawn(BUYER_COMMANDS.AGENT, 'nope');
  assert.equal(agent.status, 1);
  assert.match(agent.stderr, /^Usage: pnpm buyer:agent /);
  const unknown = spawn('nope');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /^Usage: buyer <command>/);
});

void test('every root buyer script runs the one buyer executable with its own subcommand', async () => {
  const manifest: unknown = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(manifest && typeof manifest === 'object' && 'scripts' in manifest);
  const scripts = manifest.scripts;
  assert.ok(scripts && typeof scripts === 'object');
  const buyer = Object.fromEntries(
    Object.entries(scripts).filter(
      ([name]) => name === 'buyer' || name.startsWith('buyer:'),
    ),
  );
  const script = (command: string) =>
    `node --import tsx apps/buyer/src/bin.ts ${command}`;
  assert.deepEqual(buyer, {
    buyer: script(BUYER_COMMANDS.START),
    'buyer:free': script(BUYER_COMMANDS.FREE),
    'buyer:chat': script(BUYER_COMMANDS.CHAT),
    'buyer:init': script(BUYER_COMMANDS.INIT),
    'buyer:setup': script(BUYER_COMMANDS.SETUP),
    'buyer:auto': script(BUYER_COMMANDS.AUTO),
    'buyer:agent': script(BUYER_COMMANDS.AGENT),
    'buyer:withdraw:paid': script(BUYER_COMMANDS.WITHDRAW),
  });
});

void test('buyer help documents the owner-only renewal budget and its off switch', async () => {
  const out = capture();
  const err = capture();
  await run(['--help'], BUYER_ROUTES, { out: out.stream, err: err.stream });
  assert.match(out.lines.join(''), /budget <total USDC> \| off/);
});
