// Full free path acceptance uses only temporary state, a local index, native loopback and a synthetic engine.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_CAPABILITY } from '../support/native-runtime.js';

void test('free acceptance refuses all operational overrides before running and sanitizes failures', async () => {
  const { main } = await import('@gyblos/lab-harness/cli/free-acceptance');
  for (const args of [['--real-ollama'], ['--index', 'https://discovery.gyblos.com/v1'], ['--home', '.local/gyblos']]) {
    let invoked = 0;
    const output: string[] = [];
    assert.equal(await main(args, { write: (value) => output.push(value), run: async () => { invoked++; throw new Error('PRIVATE'); } }), 1);
    assert.equal(invoked, 0);
    assert.deepEqual(output.map((value) => JSON.parse(value)), [{ ok: false, code: 'ACCEPTANCE_INVALID_OPTIONS' }]);
  }
  const output: string[] = [];
  assert.equal(await main([], { write: (value) => output.push(value), run: async () => { throw new Error('PRIVATE_KEY_PROMPT_URL'); } }), 1);
  assert.deepEqual(output.map((value) => JSON.parse(value)), [{ ok: false, code: 'ACCEPTANCE_FAILED' }]);
});
void test('free acceptance refuses pre-cancellation without allocating a session', async () => {
  const { runFreeAcceptance } = await import('@gyblos/lab-harness/acceptance/free');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runFreeAcceptance({ signal: controller.signal }), { code: 'ACCEPTANCE_CANCELLED' });
});
void test('native free acceptance proves publication to HTTP answer and typed refusal/failover cases', { skip: NATIVE_CAPABILITY.transportSkip }, async () => {
  const previous = globalThis.fetch;
  let foreignCalls = 0;
  globalThis.fetch = async () => { foreignCalls++; throw new Error('Forbidden external fetch'); };
  try {
    const { runFreeAcceptance } = await import('@gyblos/lab-harness/acceptance/free');
    const { FREE_ACCEPTANCE_CASES } = await import('@gyblos/lab-harness/acceptance/free-constants');
    const result = await runFreeAcceptance();
    assert.equal(result.ok, true);
    assert.equal(result.index, 'in-process-memory');
    assert.equal(result.nativeIroh, true);
    assert.equal(result.paymentsEnabled, false);
    assert.equal(result.mode, 'synthetic');
    assert.deepEqual(result.cases, Object.values(FREE_ACCEPTANCE_CASES));
    assert.ok(result.answers >= 4);
    assert.equal(result.queryGenerations, 0);
    assert.equal(foreignCalls, 0);
    assert.ok(!/signature|nodeId|owner|prompt|address|https?:|\.local|\/tmp\//i.test(JSON.stringify(result)));
  } finally { globalThis.fetch = previous; }
});
void test('free acceptance cancellation after the first answer releases all owned resources', { skip: NATIVE_CAPABILITY.transportSkip }, async () => {
  const { runFreeAcceptance } = await import('@gyblos/lab-harness/acceptance/free');
  const controller = new AbortController();
  let cases = 0;
  await assert.rejects(runFreeAcceptance({ signal: controller.signal, onCase: () => { cases++; controller.abort(); } }), { code: 'ACCEPTANCE_CANCELLED' });
  assert.equal(cases, 1);
});
