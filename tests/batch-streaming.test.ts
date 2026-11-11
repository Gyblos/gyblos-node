// Reusable paid streaming exposes live text before approval; cancellation never replays a prompt.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBatchSellerExecution } from '@gyblos/node/batch-session';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { EngineResult } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { CONVERSATION_INPUT, batchConversation } from './support/batch-conversation';
import { batchDeferred } from './support/batch-deferred';
import { within } from './support/test-deadline';
import { sessionRig } from './support/batch-session';

function result(text: string): EngineResult {
  return {
    text,
    finishReason: ENGINE_DONE_REASONS.STOP,
    usage: { inputTokens: 12, outputTokens: text.length, totalDurationNs: 0, loadDurationNs: 0, inputDurationNs: 0, outputDurationNs: 0 },
  };
}

void test('reusable streaming is versioned separately from the complete session-v2 wire', () => {
  assert.equal(BATCH_CHANNEL.alpn, 'gyblos/session/3');
  assert.equal(BATCH_CHANNEL.version, 3);
});

void test('live paid deltas precede completion and two requests reuse one deposit', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const first = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const chunks: string[] = [];
  f.offers.generate(async (input) => {
    await input.onText?.('ok');
    await finish.promise;
    await input.onText?.('!');
    return result('ok!');
  });
  const approve = t.mock.method(f.rig.buyer, 'approve');
  const run = f.buyer().execute(await f.quote(1), CONVERSATION_INPUT, new AbortController().signal, async (text: string) => {
    chunks.push(text);
    first.resolve();
  });
  try {
    await within(first.promise, 5000);
    assert.deepEqual(chunks, ['ok']);
    assert.equal(approve.mock.callCount(), 0);
  } finally {
    finish.resolve();
    await run.catch(() => {});
  }
  assert.equal((await run).value.text, 'ok!');
  assert.deepEqual(chunks, ['ok', '!']);
  assert.equal(approve.mock.callCount(), 1);
  await f.buyer().execute(await f.quote(2), CONVERSATION_INPUT, new AbortController().signal);
  assert.equal(approve.mock.callCount(), 2);
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.equal(f.rig.buyer.snapshot().cumulativeAtomic, '30');
});

void test('cancel after the first streamed text preserves uncertainty without another approval or prompt', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const first = batchDeferred<void>();
  const released = batchDeferred<void>();
  const aborted = batchDeferred<void>();
  const chunks: string[] = [];
  f.offers.generate(async (input) => {
    input.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
    await input.onText?.('ok');
    await released.promise;
    await input.onText?.('!');
    return result('ok!');
  });
  const approve = t.mock.method(f.rig.buyer, 'approve');
  const controller = new AbortController();
  const run = f.buyer().execute(await f.quote(1), CONVERSATION_INPUT, controller.signal, async (text: string) => {
    chunks.push(text);
    first.resolve();
  });
  void run.catch(() => {});
  try {
    await within(first.promise, 5000);
    controller.abort();
    await assert.rejects(run, { code: PAID_EXECUTION_CODES.CANCELLED });
    await within(aborted.promise, 5000);
  } finally {
    controller.abort();
    released.resolve();
    await run.catch(() => {});
  }
  assert.deepEqual(chunks, ['ok']);
  assert.equal(approve.mock.callCount(), 0);
  assert.equal(f.rig.buyer.snapshot().cumulativeAtomic, '0');
  await assert.rejects(f.buyer().execute(await f.quote(2), CONVERSATION_INPUT, new AbortController().signal));
  assert.equal(f.generated.length, 1);
  assert.deepEqual(f.rig.calls, ['deposit']);
});

void test('cancel releases an admitted stream even when its engine ignores the abort', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const seller = rig.seller();
  await seller.open(await rig.buyer.open());
  const started = batchDeferred<void>();
  const release = batchDeferred<void>();
  const controller = new AbortController();
  const finish = t.mock.method(seller, 'finish');
  let stops = 0;
  const run = runBatchSellerExecution({
    seller,
    request: { requestId: '01'.repeat(16), requestDigest: '02'.repeat(32), maxAtomic: '10' },
    peer: rig.terms.buyerNodeId,
    verify: async () => {},
    outputTokens: 10,
    deadline: rig.now() + 10000,
    now: rig.now,
    signal: controller.signal,
    errors: { timeout: () => new Error('Synthetic timeout'), cancelled: () => new Error('Synthetic cancellation') },
    nothing: { inputTokens: 0, outputTokens: 0, completed: false },
    charge: () => '0',
    open: () => ({
      generate: async () => { started.resolve(); await release.promise; return ''; },
      stop: () => { stops++; },
      measure: () => ({ inputTokens: 0, outputTokens: 0, completed: false }),
    }),
  });
  try {
    await started.promise;
    controller.abort();
    await within(run, 1000);
    assert.equal(stops, 1);
    assert.equal(finish.mock.callCount(), 1);
  } finally {
    release.resolve();
    await run;
  }
});
