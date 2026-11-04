// Owns what `gyblos seller init` refuses: values the parser or startup's offer rules reject, missing or
// malformed values, symlinks and directories at the target, unwritable locations, and its flags on other
// commands. Every refusal exits 1 and writes nothing. Offline; temporary directories only.
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';

import { inDirectory, INIT, run } from './support/init-fixture';

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

void test('seller init: values node:start would refuse write nothing and print the reason', () =>
  inDirectory(async (directory) => {
    const remote = ['--model', 'x/y', '--context-tokens', '8192'];
    for (const [args, reason] of [
      [['--url', 'http://engine.example.com:11434'], 'INSECURE_URL'],
      [['--url', 'not a url'], 'INVALID_URL'],
      [['--model', 'bad"model\u0000'], undefined],
      // Startup's own offer rules, beyond the file format.
      [['--model', 'llama3.2:1b'], 'SELLER_OFFER_MODEL_UNSUPPORTED'],
      [['--url', 'http://localhost:11435'], 'SELLER_OFFER_ENGINE_UNSUPPORTED'],
      [
        [
          '--engine',
          'anthropic',
          '--url',
          'https://api.anthropic.com/v1',
          ...remote,
        ],
        'SELLER_OFFER_ENGINE_UNSUPPORTED',
      ],
      [
        ['--engine', 'anthropic', '--api-key-env', 'none', ...remote],
        undefined,
      ],
      [
        [
          '--engine',
          'openai',
          '--api-key-env',
          'GYBLOS_RELAY_TOKEN',
          ...remote,
        ],
        'SELLER_OFFER_API_KEY_UNSAFE',
      ],
    ] as const) {
      const result = await run(directory, [...args]);
      const label = `${args.join(' ')}: ${result.output}`;
      assert.equal(result.code, 1, label);
      assert.match(result.stderr, /INIT_CONFIG_INVALID: /, label);
      if (reason)
        assert.match(
          result.stderr,
          new RegExp(`^  ${reason.replace(/[[\].]/g, '\\$&')}`, 'm'),
          label,
        );
      assert.doesNotMatch(result.stdout, /Put /, label);
      assert.deepEqual(await readdir(directory), [], label);
    }
  }));

void test('seller init: a directory that cannot be written reports INIT_WRITE_FAILED and leaves nothing', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      env: { GYBLOS_CONFIG: 'missing/gyblos.toml' },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^INIT_WRITE_FAILED: /);
    assert.deepEqual(await readdir(directory), []);
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
