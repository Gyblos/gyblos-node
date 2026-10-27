// Full free path acceptance uses only temporary state, a local index, native loopback and a synthetic engine.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test('free acceptance refuses all operational overrides before running and sanitizes failures', async () => {
  const { main } = await import('@gyblos/lab-harness/cli/free-acceptance');
  for (const args of [
    ['--real-ollama'],
    ['--index', 'https://discovery.gyblos.com/v1'],
    ['--home', '.local/gyblos'],
  ]) {
    let invoked = 0;
    const output: string[] = [];
    assert.equal(
      await main(args, {
        write: (value) => output.push(value),
        run: async () => {
          invoked++;
          throw new Error('PRIVATE');
        },
      }),
      1,
    );
    assert.equal(invoked, 0);
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
        throw new Error('PRIVATE_KEY_PROMPT_URL');
      },
    }),
    1,
  );
  assert.deepEqual(
    output.map((value) => JSON.parse(value)),
    [{ ok: false, code: 'ACCEPTANCE_FAILED' }],
  );
});
void test('free acceptance refuses pre-cancellation without allocating a session', async () => {
  const { runFreeAcceptance } =
    await import('@gyblos/lab-harness/acceptance/free');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runFreeAcceptance({ signal: controller.signal }), {
    code: 'ACCEPTANCE_CANCELLED',
  });
});
void test(
  'native free acceptance proves publication to HTTP answer and typed refusal/failover cases',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const previous = globalThis.fetch;
    let foreignCalls = 0;
    globalThis.fetch = async () => {
      foreignCalls++;
      throw new Error('Forbidden external fetch');
    };
    try {
      const { runFreeAcceptance } =
        await import('@gyblos/lab-harness/acceptance/free');
      const { FREE_ACCEPTANCE_CASES } =
        await import('@gyblos/lab-harness/acceptance/free-constants');
      const result = await runFreeAcceptance();
      assert.equal(result.ok, true);
      assert.equal(result.index, 'in-process-memory');
      assert.equal(result.nativeIroh, true);
      assert.equal(result.paymentsEnabled, false);
      assert.equal(result.mode, 'synthetic');
      assert.deepEqual(result.cases, Object.values(FREE_ACCEPTANCE_CASES));
      assert.ok(result.answers >= 4);
      assert.equal(result.queryGenerations, 0);
      assert.equal(result.queryEngineAttempts, 0);
      assert.equal(foreignCalls, 0);
      assert.ok(
        !/signature|nodeId|owner|prompt|address|https?:|\.local|\/tmp\//i.test(
          JSON.stringify(result),
        ),
      );
    } finally {
      globalThis.fetch = previous;
    }
  },
);
void test(
  'free acceptance cancellation after the first answer releases all owned resources',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const { runFreeAcceptance } =
      await import('@gyblos/lab-harness/acceptance/free');
    const controller = new AbortController();
    let cases = 0;
    await assert.rejects(
      runFreeAcceptance({
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

void test('free acceptance CLI reports unavailable native transport without any fallback or raw error', async () => {
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
      "const {main}=await import('@gyblos/lab-harness/cli/free-acceptance');process.exitCode=await main([]);",
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
  'early free acceptance cancellation has no leaked native resources or unhandled rejection',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const { spawnSync } = await import('node:child_process');
    for (const delay of [0, 1, 10, 75]) {
      const source = `const {runFreeAcceptance}=await import('@gyblos/lab-harness/acceptance/free');const controller=new AbortController();setTimeout(()=>controller.abort(),${delay});try{await runFreeAcceptance({signal:controller.signal});process.exitCode=2;}catch(error){console.log(JSON.stringify({cancelled:error.code==='ACCEPTANCE_CANCELLED'}));}`;
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
