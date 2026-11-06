// Controls the synthetic service clock and digest so deadlines before/during execution cannot hang tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { paidExecutionDigest } from '@gyblos/protocol/paid-execution';
import { encodePaidExecutionRequest } from '@gyblos/protocol/paid-stream';
import { PAID_EXECUTION } from '@gyblos/protocol/paid/constants';
import { servePaidExecutionStream, type PaidExecutionService } from '@gyblos/transport-iroh/paid-server';
import { CHARGE, request, RESULT, settled } from './support/paid-fixture';
import { waitForTestAbort } from './support/test-abort';

async function fixture() {
  const paid = await request();
  const bytes = encodePaidExecutionRequest(paid);
  const terminal = { version: PAID_EXECUTION.version, requestId: paid.requestId, requestDigest: await paidExecutionDigest(paid), result: RESULT, charge: CHARGE, payment: settled(paid, CHARGE.chargedAtomic) };
  let offset = 0;
  const counts = { closed: 0, released: 0, writes: 0 };
  const stream = {
    recv: { readExact: async (size: number) => { const part = bytes.subarray(offset, offset + size); offset += size; return [...part]; }, read: async () => [] },
    send: { writeAll: async () => { counts.writes++; }, finish: async () => {} },
  };
  return { terminal, stream, counts, close: () => { counts.closed++; }, enter: () => () => { counts.released++; } };
}
void test('the request deadline aborts generation and closes the stream', { timeout: 15000 }, async (context) => {
  const value = await fixture();
  const controller = new AbortController();
  let entered = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const service: PaidExecutionService = { async stream(_request, _peer, signal) { entered(); await waitForTestAbort(signal); aborted = true; return value.terminal; } };
  const running = servePaidExecutionStream(value.stream, service, 'synthetic', value.close, AbortSignal.any([controller.signal, context.signal]), value.enter, () => true, { requestMs: 20 });
  try {
    await started;
    context.mock.timers.tick(19);
    assert.equal(aborted, false);
    assert.equal(value.counts.closed, 0);
    context.mock.timers.tick(1);
    await running;
    assert.equal(aborted, true);
    assert.deepEqual(value.counts, { closed: 1, released: 1, writes: 0 });
  } finally { controller.abort(); await running; }
});
void test('a deadline during request digest cannot strand an already-cancelled synthetic service', { timeout: 15000 }, async (context) => {
  const value = await fixture();
  const realDelay = delay;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let reached = () => {};
  let release = () => {};
  let force = () => {};
  let entered = () => {};
  const hashing = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const forced = new Promise<void>((resolve) => { force = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  context.mock.method(crypto.subtle, 'digest', async (...args: Parameters<SubtleCrypto['digest']>) => { reached(); await released; return digest(...args); });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let alreadyAborted = false;
  const service: PaidExecutionService = { async stream(_request, _peer, signal) { alreadyAborted = signal.aborted; entered(); await Promise.race([waitForTestAbort(signal), forced]); return value.terminal; } };
  const running = servePaidExecutionStream(value.stream, service, 'synthetic', value.close, AbortSignal.any([controller.signal, context.signal]), value.enter, () => true, { requestMs: 20 });
  try {
    await hashing;
    context.mock.timers.tick(20);
    assert.equal(value.counts.closed, 1);
    release();
    await started;
    assert.equal(alreadyAborted, true);
    assert.equal(await Promise.race([running.then(() => true), realDelay(50, false)]), true);
    assert.deepEqual(value.counts, { closed: 1, released: 1, writes: 0 });
  } finally { force(); release(); controller.abort(); await running; }
});
