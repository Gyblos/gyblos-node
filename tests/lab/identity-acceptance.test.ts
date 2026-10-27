// Complete identity acceptance is synthetic-only: local index/RPC, native Iroh and fake engine.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_TEST_OPTIONS } from '../support/native-runtime.js';

void test('identity acceptance CLI refuses operational overrides and never reflects raw failures', async () => {
  const { main } = await import('@gyblos/lab-harness/cli/identity-acceptance');
  for (const args of [
    ['--rpc', 'https://rpc.invalid'],
    ['--index', 'https://discovery.gyblos.com/v1'],
    ['--home', '.local/gyblos'],
    ['--real-ollama'],
  ]) {
    let calls = 0;
    const output: string[] = [];
    assert.equal(
      await main(args, {
        write: (value) => output.push(value),
        run: async () => {
          calls++;
          throw new Error('PRIVATE');
        },
      }),
      1,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      output.map((value) => JSON.parse(value)),
      [{ ok: false, code: 'ACCEPTANCE_INVALID_OPTIONS' }],
    );
  }
  const output: string[] = [];
  assert.equal(
    await main([], {
      write: (value) => output.push(value),
      run: async () => {
        throw new Error('PRIVATE_URL_BODY_KEY');
      },
    }),
    1,
  );
  assert.deepEqual(
    output.map((value) => JSON.parse(value)),
    [{ ok: false, code: 'ACCEPTANCE_FAILED' }],
  );
});
void test('identity acceptance pre-cancellation allocates no session', async () => {
  const { runIdentityAcceptance } =
    await import('@gyblos/lab-harness/acceptance/identity');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runIdentityAcceptance({ signal: controller.signal }), {
    code: 'ACCEPTANCE_CANCELLED',
  });
});
void test(
  'native identity acceptance proves discovery, independent registry trust, full and streaming answers with persistent fail-closed history',
  NATIVE_TEST_OPTIONS,
  async () => {
    const { runIdentityAcceptance } =
      await import('@gyblos/lab-harness/acceptance/identity');
    const { IDENTITY_ACCEPTANCE_CASES } =
      await import('@gyblos/lab-harness/acceptance/identity-constants');
    const original = globalThis.fetch;
    let externalCalls = 0;
    globalThis.fetch = async (input, init) => {
      const target = new URL(
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input.url,
      );
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
        externalCalls++;
        throw new Error('Forbidden external fetch');
      }
      return original(input, init);
    };
    try {
      const report = await runIdentityAcceptance();
      assert.equal(report.ok, true);
      assert.equal(report.nativeIroh, true);
      assert.equal(report.identityEnabled, true);
      assert.equal(report.registry, 'loopback-synthetic');
      assert.equal(report.index, 'in-process-memory');
      assert.equal(report.paymentsEnabled, false);
      assert.deepEqual(report.cases, Object.values(IDENTITY_ACCEPTANCE_CASES));
      assert.ok(report.answers >= 7);
      assert.ok(report.registryReads > 0);
      assert.equal(report.forbiddenRpcMethods, 0);
      assert.equal(report.queryGenerations, 0);
      assert.equal(report.queryEngineAttempts, 0);
      assert.equal(report.noPostSendRetry, true);
      assert.equal(externalCalls, 0);
      assert.doesNotMatch(
        JSON.stringify(report),
        /signature|nodeId|owner|prompt|address|https?:|\.local|\/tmp\//i,
      );
    } finally {
      globalThis.fetch = original;
    }
  },
);
void test(
  'native identity acceptance cancellation after the first completed case closes all owned resources',
  NATIVE_TEST_OPTIONS,
  async () => {
    const { runIdentityAcceptance } =
      await import('@gyblos/lab-harness/acceptance/identity');
    const controller = new AbortController();
    let cases = 0;
    await assert.rejects(
      runIdentityAcceptance({
        signal: controller.signal,
        onCase: () => {
          cases++;
          controller.abort();
        },
      }),
      { code: 'ACCEPTANCE_CANCELLED' },
    );
    assert.equal(cases, 1);
  },
);

void test('identity acceptance CLI reports unavailable native transport without any fallback or raw error', async () => {
  const { spawnSync } = await import('node:child_process');
  const replacement =
    'throw new Error("Cannot find native binding PRIVATE_VALUE");';
  const resolver = `export function resolve(specifier,context,next){if(specifier==='@number0/iroh')return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true};return next(specifier,context);}`;
  const bootstrap = `import {register} from 'node:module';register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(resolver))});`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,' + encodeURIComponent(bootstrap),
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "const {main}=await import('@gyblos/lab-harness/cli/identity-acceptance');process.exitCode=await main([]);",
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'ACCEPTANCE_NATIVE_UNAVAILABLE',
  });
});

void test(
  'early identity acceptance cancellation has no leaked native resources or unhandled rejection',
  NATIVE_TEST_OPTIONS,
  async () => {
    const { spawnSync } = await import('node:child_process');
    for (const delay of [0, 1, 10, 75]) {
      const source = `const {runIdentityAcceptance}=await import('@gyblos/lab-harness/acceptance/identity');const controller=new AbortController();setTimeout(()=>controller.abort(),${delay});try{await runIdentityAcceptance({signal:controller.signal});process.exitCode=2;}catch(error){console.log(JSON.stringify({cancelled:error.code==='ACCEPTANCE_CANCELLED'}));}`;
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', source],
        {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 65536,
          env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { cancelled: true });
    }
  },
);
