// Owns the `gyblos seller init` contract: a gyblos.toml that node:start accepts, one question per missing
// value on a terminal and defaults otherwise, no overwrite without --force, no write through a symlink,
// nothing written on invalid or cancelled input, and no secret or URL path in any output. Offline;
// temporary directories only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { resolveNodeConfig } from '@gyblos/node/node-config-resolve';

import { FAKE_SECRET, REPOSITORY_ROOT } from './support/node-config-fixtures';

const INIT = ['seller', 'init'];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
  questions: string[];
}

async function inDirectory<T>(use: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-init-'));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// answers === undefined runs without a terminal; otherwise each question takes the next answer.
async function run(
  directory: string,
  args: string[],
  options: {
    answers?: string[];
    env?: Record<string, string>;
    cancelAt?: number;
  } = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const questions: string[] = [];
  const answers = options.answers ? [...options.answers] : undefined;
  const code = await runCli([...INIT, ...args], {
    env: options.env ?? {},
    cwd: directory,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: answers
      ? (question) => {
          questions.push(question);
          if (questions.length === options.cancelAt)
            return Promise.reject(new Error('aborted'));
          return Promise.resolve(answers.shift() ?? '');
        }
      : undefined,
  });
  return { code, stdout, stderr, output: stdout + stderr, questions };
}

async function configOf(path: string) {
  const parsed = parseNodeConfig(await readFile(path, 'utf8'));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const resolved = resolveNodeConfig({ file: parsed.config, env: {} });
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return { file: parsed.config, settings: resolved.settings };
}

void test('seller init: without a terminal it writes the default free Ollama offer that node:start reads', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, []);
    assert.equal(result.code, 0, result.output);
    const path = join(directory, 'gyblos.toml');
    const { file, settings } = await configOf(path);
    assert.equal(settings.network, 'devnet');
    assert.equal(file.discovery?.publish, false);
    assert.equal(settings.offers.length, 1);
    const [entry] = settings.offers;
    assert.equal(entry!.model.id, 'qwen3-0.6b');
    assert.deepEqual(entry!.engine, {
      kind: 'ollama',
      url: 'http://127.0.0.1:11435',
    });
    assert.deepEqual(entry!.pricing, {
      kind: 'free',
      dailyTokenCap: 200000,
      perBuyerCap: 5000,
    });
    assert.equal((await lstat(path)).mode & 0o777, 0o644);
    assert.deepEqual(await readdir(directory), ['gyblos.toml']);
    assert.match(
      result.stdout,
      /OLLAMA_HOST=127\.0\.0\.1:11435 ollama pull qwen3:0\.6b/,
    );
    assert.match(
      result.stdout,
      /GYBLOS_RELAY_TOKEN=<your token> in seller\.env/,
    );
    assert.match(result.stdout, /pnpm gyblos doctor/);
  }));

void test('seller init: on a terminal it asks each missing value, in order, and writes the answers', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      answers: [
        'anthropic',
        '',
        'acme/claude-chat',
        'claude-sonnet-4-5',
        '200000',
        '',
        '100000',
        '2000',
        'y',
      ],
    });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      result.questions.map((question) => question.replace(/ \[.*$/, '')),
      [
        'Engine (ollama, openai or anthropic)',
        'Engine URL',
        'Model to offer: ',
        'Model name at the provider',
        'Context window in tokens: ',
        'Variable holding the API key (none for no key)',
        'Free tokens per day, all buyers',
        'Free tokens per buyer per day',
        'List this seller in the public discovery index?',
      ],
    );
    const { file, settings } = await configOf(join(directory, 'gyblos.toml'));
    assert.equal(file.discovery?.publish, true);
    const [entry] = settings.offers;
    assert.equal(entry!.model.kind, 'custom');
    assert.deepEqual(entry!.engine, {
      kind: 'anthropic',
      url: 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      upstreamModel: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });
    assert.deepEqual(entry!.pricing, {
      kind: 'free',
      dailyTokenCap: 100000,
      perBuyerCap: 2000,
    });
    assert.match(
      result.stdout,
      /Put ANTHROPIC_API_KEY=<your API key> in seller\.env/,
    );
    assert.doesNotMatch(result.stdout, /ollama pull/);
  }));

void test('seller init: flags are never asked again, and "none" leaves the API key out', () =>
  inDirectory(async (directory) => {
    const result = await run(
      directory,
      [
        '--engine',
        'openai',
        '--url',
        'http://127.0.0.1:1234/v1',
        '--model',
        'gpt-oss-20b',
        '--context-tokens',
        '131072',
        '--api-key-env',
        'none',
        '--daily-cap',
        '1000',
        '--per-buyer-cap',
        '100',
        '--publish',
      ],
      { answers: [] },
    );
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(result.questions, [
      'Model name at the provider [gpt-oss-20b]: ',
    ]);
    const { settings } = await configOf(join(directory, 'gyblos.toml'));
    assert.deepEqual(settings.offers[0]!.engine, {
      kind: 'openai',
      url: 'http://127.0.0.1:1234/v1',
      upstreamModel: 'gpt-oss-20b',
      contextTokens: 131072,
    });
    assert.doesNotMatch(result.stdout, /API key/);
  }));

void test('seller init: a catalog id is pulled by its Ollama alias', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, ['--model', 'qwen3-0.6b']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /ollama pull qwen3:0\.6b\n/);
  }));

void test('seller init: an existing file is kept without --force and replaced with it', () =>
  inDirectory(async (directory) => {
    const path = join(directory, 'gyblos.toml');
    await writeFile(path, 'kept\n');
    const refused = await run(directory, []);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /INIT_FILE_EXISTS/);
    assert.equal(await readFile(path, 'utf8'), 'kept\n');
    // Refused before any question is asked.
    const asked = await run(directory, [], { answers: ['ollama'] });
    assert.deepEqual(asked.questions, []);
    const replaced = await run(directory, ['--force']);
    assert.equal(replaced.code, 0, replaced.output);
    await configOf(path);
    assert.deepEqual(await readdir(directory), ['gyblos.toml']);
  }));

void test('seller init: never writes through a symlink or over a directory, even with --force', () =>
  inDirectory(async (directory) => {
    const target = join(directory, 'target.txt');
    await writeFile(target, 'untouched\n');
    await symlink(target, join(directory, 'gyblos.toml'));
    const result = await run(directory, ['--force']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /INIT_UNSAFE_PATH/);
    assert.equal(await readFile(target, 'utf8'), 'untouched\n');
    assert.ok((await lstat(join(directory, 'gyblos.toml'))).isSymbolicLink());

    await mkdir(join(directory, 'folder.toml'));
    const nested = await run(directory, ['--force'], {
      env: { GYBLOS_CONFIG: 'folder.toml' },
    });
    assert.equal(nested.code, 1);
    assert.match(nested.stderr, /INIT_UNSAFE_PATH/);
  }));

void test('seller init: writes to GYBLOS_CONFIG, relative to the working directory', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      env: { GYBLOS_CONFIG: 'seller.toml' },
    });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await readdir(directory), ['seller.toml']);
    await configOf(join(directory, 'seller.toml'));
  }));

void test('seller init: values node:start would refuse write nothing and print the parser codes', () =>
  inDirectory(async (directory) => {
    for (const [args, code] of [
      [['--url', 'http://engine.example.com:11434'], 'INSECURE_URL'],
      [['--url', 'not a url'], 'offers[0].engine.url'],
      [['--model', 'bad"model\u0000'], 'INIT_CONFIG_INVALID'],
    ] as const) {
      const result = await run(directory, [...args]);
      assert.equal(result.code, 1, `${args.join(' ')}: ${result.output}`);
      assert.match(result.stderr, new RegExp(code.replace(/[[\].]/g, '\\$&')));
      assert.deepEqual(await readdir(directory), [], args.join(' '));
    }
  }));

void test('seller init: missing, unknown or non-numeric values stop before writing', () =>
  inDirectory(async (directory) => {
    for (const [args, code, flag] of [
      [
        ['--engine', 'openai', '--model', 'x/y'],
        'INIT_MISSING_VALUE',
        '--context-tokens',
      ],
      [['--engine', 'anthropic'], 'INIT_MISSING_VALUE', '--model'],
      [['--engine', 'vllm'], 'INIT_INVALID_ENGINE', '--engine'],
      [['--daily-cap', '0'], 'INIT_INVALID_NUMBER', '--daily-cap'],
      [['--per-buyer-cap', '5e3'], 'INIT_INVALID_NUMBER', '--per-buyer-cap'],
      [
        ['--engine', 'openai', '--model', 'x/y', '--context-tokens', '1.5'],
        'INIT_INVALID_NUMBER',
        '--context-tokens',
      ],
    ] as const) {
      const result = await run(directory, [...args]);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, new RegExp(`${code} ${flag}:`));
      assert.deepEqual(await readdir(directory), []);
    }
  }));

void test('seller init: a cancelled question exits 130 and writes nothing', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      answers: ['ollama'],
      cancelAt: 2,
    });
    assert.equal(result.code, 130);
    assert.match(result.stderr, /cancelled; nothing was written/);
    assert.deepEqual(await readdir(directory), []);
  }));

void test('seller init: prints URLs as origins and never a secret from the environment', () =>
  inDirectory(async (directory) => {
    const result = await run(
      directory,
      [
        '--engine',
        'openai',
        '--url',
        `https://api.example.com/v1/${FAKE_SECRET}`,
        '--model',
        'x/y',
        '--context-tokens',
        '8192',
        '--api-key-env',
        'UPSTREAM_API_KEY',
      ],
      {
        env: { UPSTREAM_API_KEY: FAKE_SECRET, GYBLOS_RELAY_TOKEN: FAKE_SECRET },
      },
    );
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, new RegExp(FAKE_SECRET));
    assert.match(result.stdout, /https:\/\/api\.example\.com <path hidden>/);
  }));

void test('seller init: its flags are refused on other commands, and other flags on init', async () => {
  for (const args of [
    ['doctor', '--force'],
    ['config', 'validate', '--engine', 'ollama'],
    ['seller', 'service', 'install', '--publish'],
    [...INIT, '--online'],
    [...INIT, '--config', 'x.toml'],
    [...INIT, '--dry-run'],
    [...INIT, 'extra'],
  ]) {
    let stderr = '';
    const code = await runCli(args, {
      env: {},
      cwd: '/nonexistent',
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, /^Usage:/, args.join(' '));
  }
});

void test('seller init: the script entry takes defaults without a terminal and sets the exit code', () =>
  inDirectory(async (directory) => {
    const path = join(directory, 'gyblos.toml');
    const script = (args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/node/src/cli.ts', ...INIT, ...args],
        {
          cwd: REPOSITORY_ROOT,
          env: { ...process.env, GYBLOS_CONFIG: path },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    const written = script([]);
    assert.equal(written.status, 0, written.stderr);
    await configOf(path);
    const refused = script([]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /INIT_FILE_EXISTS/);
  }));
