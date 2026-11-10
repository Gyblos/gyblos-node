// Owns the `gyblos seller init` contract for a successful run: a gyblos.toml that node:start accepts, one
// question per missing value on a terminal and defaults otherwise, --force, GYBLOS_CONFIG, and no secret or
// URL path in any output. Offline; temporary directories only. Refusals are in node-init-refusal.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { configOf, inDirectory, INIT, run } from './support/init-fixture';
import { FAKE_SECRET, REPOSITORY_ROOT } from './support/node-config-fixtures';

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
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['gyblos.toml']);
    assert.match(
      result.stdout,
      /OLLAMA_HOST=127\.0\.0\.1:11435 ollama pull qwen3:0\.6b/,
    );
    assert.match(
      result.stdout,
      /GYBLOS_RELAY_TOKEN=<your token> in seller\.env/,
    );
    assert.match(result.stdout, /`gyblos doctor`/);
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
    assert.deepEqual(result.questions, [
      'Engine (ollama, openai or anthropic) [ollama]: ',
      'Engine URL [https://api.anthropic.com]: ',
      'Model to offer: ',
      'Model name at the provider [acme/claude-chat]: ',
      'Context window in tokens: ',
      'Variable holding the API key [ANTHROPIC_API_KEY]: ',
      'Free tokens per day, all buyers [200000]: ',
      'Free tokens per buyer per day [5000]: ',
      'List this seller in the public discovery index? [y/N]: ',
    ]);
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
        'acme/local-chat',
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
      'Model name at the provider [acme/local-chat]: ',
    ]);
    const { settings } = await configOf(join(directory, 'gyblos.toml'));
    assert.deepEqual(settings.offers[0]!.engine, {
      kind: 'openai',
      url: 'http://127.0.0.1:1234/v1',
      upstreamModel: 'acme/local-chat',
      contextTokens: 131072,
    });
    assert.doesNotMatch(result.stdout, /API key/);
  }));

void test('seller init: OpenAI defaults to OPENAI_API_KEY, and any answer but yes keeps discovery off', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      answers: ['openai', '', 'x/y', '', '8192', '', '', '', 'n'],
    });
    assert.equal(result.code, 0, result.output);
    const { file, settings } = await configOf(join(directory, 'gyblos.toml'));
    assert.equal(file.discovery?.publish, false);
    assert.equal(settings.offers[0]!.engine.apiKeyEnv, 'OPENAI_API_KEY');
    assert.equal(settings.offers[0]!.engine.url, 'https://api.openai.com/v1');
  }));

void test('seller init: --no-publish answers the discovery question, and both flags together are refused', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, ['--no-publish'], {
      answers: ['', '', '', '', ''],
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.questions.length, 5);
    const { file } = await configOf(join(directory, 'gyblos.toml'));
    assert.equal(file.discovery?.publish, false);
    const both = await run(directory, ['--publish', '--no-publish', '--force']);
    assert.equal(both.code, 1);
    assert.match(both.stderr, /^Usage:/);
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

void test('seller init: writes to GYBLOS_CONFIG, relative to the working directory', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      env: { GYBLOS_CONFIG: 'seller.toml' },
    });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await readdir(directory), ['seller.toml']);
    await configOf(join(directory, 'seller.toml'));
  }));

void test('seller init: a cancelled question exits 130 and writes nothing', () =>
  inDirectory(async (directory) => {
    const result = await run(directory, [], {
      answers: ['ollama'],
      cancelAt: 2,
    });
    assert.equal(result.code, 130);
    assert.match(result.stderr, /^INIT_CANCELLED: nothing was written/);
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

void test('seller init: the script entry takes defaults without a terminal and sets the exit code', () =>
  inDirectory(async (directory) => {
    const path = join(directory, 'gyblos.toml');
    const script = (args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/node/src/bin.ts', ...INIT, ...args],
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
