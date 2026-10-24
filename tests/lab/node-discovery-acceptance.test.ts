// Exercises isolated acceptance contracts without real engines, RPC, payments or a public index.
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import test from 'node:test';

import { NATIVE_CAPABILITY } from '../support/native-runtime.js';

void test('acceptance defaults to synthetic and refuses configuration, index and home overrides', async () => {
  const { parseAcceptanceArgs } =
    await import('@gyblos/lab-harness/acceptance/options');
  assert.equal(parseAcceptanceArgs([]).mode, 'synthetic');
  assert.equal(parseAcceptanceArgs(['--real-ollama']).mode, 'ollama');
  for (const args of [
    ['--index', 'https://discovery.gyblos.com/v1'],
    ['--home', '.local/gyblos'],
    ['--real-ollama', '--synthetic'],
    ['PRIVATE_INPUT'],
  ]) {
    assert.throws(() => parseAcceptanceArgs(args), {
      code: 'ACCEPTANCE_INVALID_OPTIONS',
    });
  }
});

void test('acceptance workspace owns temporary private role homes and removes only its own root', async () => {
  const { createAcceptanceWorkspace } =
    await import('@gyblos/lab-harness/acceptance/workspace');
  const { homeLayout } = await import('@gyblos/config/home');
  const workspace = await createAcceptanceWorkspace();
  const layout = homeLayout(workspace.environment);
  assert.ok(!workspace.root.includes('/.local/'));
  for (const directory of [
    workspace.root,
    layout.roles.buyer,
    layout.roles.seller,
  ]) {
    assert.equal((await lstat(directory)).isDirectory(), true);
    if (process.platform !== 'win32')
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  }
  await workspace.close();
  await workspace.close();
  await assert.rejects(lstat(workspace.root), { code: 'ENOENT' });
});

void test('acceptance local index refuses every foreign origin without touching global fetch', async () => {
  const { createAcceptanceIndex } =
    await import('@gyblos/lab-harness/acceptance/index');
  const index = createAcceptanceIndex(() => Date.now(), '1'.repeat(64));
  const response = await index.fetch(`${index.baseUrl}/health`, {});
  assert.equal(response.status, 200);
  await assert.rejects(
    index.fetch('https://discovery.gyblos.com/v1/health', {}),
    { code: 'ACCEPTANCE_EXTERNAL_IO' },
  );
});

void test('acceptance CLI emits only a static failure code even when its dependency throws private contents', async () => {
  const { main } =
    await import('@gyblos/lab-harness/cli/node-discovery-acceptance');
  const messages: string[] = [];
  const exit = await main([], {
    write: (value) => messages.push(value),
    run: async () => {
      throw new Error('PRIVATE_KEY_URL_PROMPT_PATH');
    },
  });
  assert.equal(exit, 1);
  assert.deepEqual(
    messages.map((value) => JSON.parse(value)),
    [{ ok: false, code: 'ACCEPTANCE_FAILED' }],
  );
});

void test('acceptance refuses pre-cancelled runs before allocating endpoints or engine work', async () => {
  const { runNodeDiscoveryAcceptance } =
    await import('@gyblos/lab-harness/acceptance');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runNodeDiscoveryAcceptance({ signal: controller.signal }),
    { code: 'ACCEPTANCE_CANCELLED' },
  );
});

void test(
  'native acceptance proves discovery, renewal, expiry, busy, failure, restart and replay with sanitized evidence',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const { runNodeDiscoveryAcceptance } =
      await import('@gyblos/lab-harness/acceptance');
    const { ACCEPTANCE_CASES } =
      await import('@gyblos/lab-harness/acceptance/constants');
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('External fetch forbidden');
    };
    try {
      const report = await runNodeDiscoveryAcceptance();
      assert.equal(report.ok, true);
      assert.equal(report.mode, 'synthetic');
      assert.equal(report.clock, 'accelerated');
      assert.equal(report.nativeIroh, true);
      assert.equal(report.paymentsEnabled, false);
      assert.equal(report.index, 'in-process-memory');
      assert.deepEqual(report.cases, Object.values(ACCEPTANCE_CASES));
      assert.ok(report.renewals >= 3);
      assert.equal(calls, 0);
      const text = JSON.stringify(report);
      assert.ok(
        !/signature|nodeId|owner|prompt|address|https?:|\.local|\/tmp\//i.test(
          text,
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

void test('acceptance refuses temporary roots inside operational local state before filesystem allocation', async () => {
  const { assertAcceptanceTempBase } =
    await import('@gyblos/lab-harness/acceptance/workspace');
  for (const value of [
    '/tmp/.local',
    '/home/user/.local/gyblos',
    'relative',
    '/tmp/../.local',
  ])
    assert.throws(() => assertAcceptanceTempBase(value), {
      code: 'ACCEPTANCE_UNSAFE_TEMP',
    });
  assert.doesNotThrow(() => assertAcceptanceTempBase('/private/tmp'));
});

void test('acceptance CLI rejects unknown options before invoking its runner', async () => {
  const { main } =
    await import('@gyblos/lab-harness/cli/node-discovery-acceptance');
  let invoked = 0;
  const messages: string[] = [];
  const exit = await main(['--index', 'PRIVATE_REMOTE_URL'], {
    write: (value) => messages.push(value),
    run: async () => {
      invoked++;
      throw new Error('must not run');
    },
  });
  assert.equal(exit, 1);
  assert.equal(invoked, 0);
  assert.deepEqual(
    messages.map((value) => JSON.parse(value)),
    [{ ok: false, code: 'ACCEPTANCE_INVALID_OPTIONS' }],
  );
});

void test(
  'acceptance cancellation after its first real local quote closes its resources and reports cancellation',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const { runNodeDiscoveryAcceptance } =
      await import('@gyblos/lab-harness/acceptance');
    const controller = new AbortController();
    let completed = 0;
    await assert.rejects(
      runNodeDiscoveryAcceptance({
        signal: controller.signal,
        onCase: () => {
          completed++;
          controller.abort();
        },
      }),
      { code: 'ACCEPTANCE_CANCELLED' },
    );
    assert.equal(completed, 1);
  },
);

void test('acceptance reports unavailable native Iroh without synthetic transport fallback or raw errors', async () => {
  const { spawnSync } = await import('node:child_process');
  const sdkSource =
    'throw new Error("Cannot find native binding PRIVATE_VALUE");';
  const resolver = `export function resolve(specifier,context,next){
    if(specifier==='@number0/iroh')return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(sdkSource))},shortCircuit:true};
    return next(specifier,context);
  }`;
  const bootstrap = `import { register } from 'node:module';register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(resolver))});`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,' + encodeURIComponent(bootstrap),
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "const {main}=await import('@gyblos/lab-harness/cli/node-discovery-acceptance');process.exitCode=await main([]);",
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'ACCEPTANCE_NATIVE_UNAVAILABLE',
  });
  assert.equal(result.stderr, '');
});
