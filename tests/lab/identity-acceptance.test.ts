// Complete identity acceptance is synthetic-only: local index/RPC, native Iroh and fake engine.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_TEST_OPTIONS } from '../support/native-runtime.js';

void test('identity acceptance CLI refuses operational overrides and never reflects raw failures', async () => {
  const { main } = await import('@gyblos/lab-harness/cli/identity-acceptance');
  for (const args of [['--rpc', 'https://rpc.invalid'], ['--index', 'https://discovery.gyblos.com/v1'], ['--home', '.local/gyblos'], ['--real-ollama']]) {
    let calls = 0;
    const output: string[] = [];
    assert.equal(await main(args, { write: value => output.push(value), run: async () => { calls++; throw new Error('PRIVATE'); } }), 1);
    assert.equal(calls, 0);
    assert.deepEqual(output.map(value => JSON.parse(value)), [{ ok: false, code: 'ACCEPTANCE_INVALID_OPTIONS' }]);
  }
  const output: string[] = [];
  assert.equal(await main([], { write: value => output.push(value), run: async () => { throw new Error('PRIVATE_URL_BODY_KEY'); } }), 1);
  assert.deepEqual(output.map(value => JSON.parse(value)), [{ ok: false, code: 'ACCEPTANCE_FAILED' }]);
});
void test('identity acceptance pre-cancellation allocates no session', async () => {
  const { runIdentityAcceptance } = await import('@gyblos/lab-harness/acceptance/identity');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runIdentityAcceptance({ signal: controller.signal }), { code: 'ACCEPTANCE_CANCELLED' });
});
void test('native identity acceptance proves discovery, independent registry trust, full and streaming answers with persistent fail-closed history', NATIVE_TEST_OPTIONS, async () => {
  const { runIdentityAcceptance } = await import('@gyblos/lab-harness/acceptance/identity');
  const { IDENTITY_ACCEPTANCE_CASES } = await import('@gyblos/lab-harness/acceptance/identity-constants');
  const original = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') { externalCalls++; throw new Error('Forbidden external fetch'); }
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
    assert.doesNotMatch(JSON.stringify(report), /signature|nodeId|owner|prompt|address|https?:|\.local|\/tmp\//i);
  } finally { globalThis.fetch = original; }
});
void test('native identity acceptance cancellation after the first completed case closes all owned resources', NATIVE_TEST_OPTIONS, async () => {
  const { runIdentityAcceptance } = await import('@gyblos/lab-harness/acceptance/identity');
  const controller = new AbortController();
  let cases = 0;
  await assert.rejects(runIdentityAcceptance({ signal: controller.signal, onCase: () => { cases++; controller.abort(); } }), { code: 'ACCEPTANCE_CANCELLED' });
  assert.equal(cases, 1);
});
