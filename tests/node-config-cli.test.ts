// Owns the `gyblos config validate` contract: exit codes 0/1, a summary or a list of codes with paths,
// and no secret or environment variable value in any output. Offline; temporary files only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';

import {
  BASE,
  exampleFiles,
  FAKE_SECRET,
  offer,
  REPOSITORY_ROOT,
} from './support/node-config-fixtures.js';
import { INVALID_FIXTURES } from './support/node-config-invalid.js';

// Every value here is a fake secret or private location that must never be printed.
const SECRET_ENVIRONMENT = {
  GYBLOS_RELAY_TOKEN: `${FAKE_SECRET}-relay`,
  UPSTREAM_API_KEY: `${FAKE_SECRET}-upstream`,
  ANTHROPIC_UPSTREAM_KEY: `${FAKE_SECRET}-anthropic`,
  GYBLOS_RPC_URL: `https://rpc.example.com/?api-key=${FAKE_SECRET}`,
  GYBLOS_HOME: `/private/${FAKE_SECRET}/home`,
  GYBLOS_DISCOVERY_URL: `https://${FAKE_SECRET.toLowerCase()}.example/v1`,
};

async function run(args: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, output: stdout + stderr };
}

async function withFile<T>(toml: string, use: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-cli-'));
  try {
    const path = join(directory, 'gyblos.toml');
    await writeFile(path, toml);
    return await use(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('validate exits 0 with a summary for every example and prints no secret values', async () => {
  for (const example of exampleFiles()) {
    const result = await run(
      ['config', 'validate', '--config', example.path],
      SECRET_ENVIRONMENT,
    );
    assert.equal(result.code, 0, `${example.name}: ${result.output}`);
    assert.match(result.stdout, /OK/);
    assert.match(result.stdout, /network\s+devnet/);
    assert.equal(result.output.includes('FAKE0SECRET'), false, example.name);
    assert.equal(result.output.includes('fake0secret'), false, example.name);
  }
});

void test('the summary names environment sources and secret variables without their values', async () => {
  const toml =
    BASE +
    offer({
      engine:
        '{ kind = "openai", url = "https://api.example.com/v1", api_key_env = "UPSTREAM_API_KEY" }',
    });
  await withFile(toml, async (path) => {
    const result = await run(
      ['config', 'validate', '--config', path],
      SECRET_ENVIRONMENT,
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /GYBLOS_RPC_URL/);
    assert.match(result.stdout, /GYBLOS_HOME/);
    assert.match(result.stdout, /GYBLOS_RELAY_TOKEN\s+set/);
    assert.match(result.stdout, /UPSTREAM_API_KEY\s+set/);
    assert.equal(result.output.includes('FAKE0SECRET'), false);
    assert.equal(result.output.includes('fake0secret'), false);
    const unset = await run(['config', 'validate', '--config', path]);
    assert.match(unset.stdout, /UPSTREAM_API_KEY\s+not set/);
  });
});

void test('validate exits 1 and lists codes with paths for every invalid fixture, without values', async () => {
  for (const fixture of INVALID_FIXTURES)
    await withFile(fixture.toml, async (path) => {
      const result = await run(['config', 'validate', '--config', path]);
      assert.equal(result.code, 1, fixture.name);
      assert.match(
        result.stderr,
        new RegExp(
          `${fixture.code}\\s+${fixture.path.replace(/[[\].]/g, '\\$&')}`,
        ),
        fixture.name,
      );
      assert.equal(result.output.includes('FAKE0SECRET'), false, fixture.name);
    });
});

void test('missing files, usage errors and invalid environment values exit 1', async () => {
  const missing = await run([
    'config',
    'validate',
    '--config',
    '/nonexistent/gyblos.toml',
  ]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /FILE_NOT_FOUND/);
  for (const args of [
    [],
    ['config'],
    ['config', 'nope'],
    ['start'],
    ['config', 'validate', '--bogus'],
  ]) {
    const usage = await run(args);
    assert.equal(usage.code, 1, args.join(' '));
    assert.match(usage.stderr, /Usage: gyblos config validate/);
  }
  await withFile(BASE, async (path) => {
    const result = await run(['config', 'validate', '--config', path], {
      GYBLOS_RPC_URL: `ftp://${FAKE_SECRET}`,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /INVALID_URL\s+env\.GYBLOS_RPC_URL/);
    assert.equal(result.output.includes('FAKE0SECRET'), false);
  });
});

void test('the gyblos script entry sets the process exit code', async () => {
  const [example] = exampleFiles();
  assert.ok(example);
  const environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
  const ok = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/node/src/cli.ts',
      'config',
      'validate',
      '--config',
      example.path,
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: environment,
    },
  );
  assert.equal(ok.status, 0, ok.stderr);
  await withFile(`${BASE}colour = "blue"\n`, async (path) => {
    const bad = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/node/src/cli.ts',
        'config',
        'validate',
        '--config',
        path,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: environment,
      },
    );
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stderr, /UNKNOWN_KEY\s+node\.colour/);
  });
});
