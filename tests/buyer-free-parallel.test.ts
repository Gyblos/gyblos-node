// Free requests side by side: two at once go to different sellers, a second one with no free seller left is
// busy (not a failure), a third is refused at the door, every reservation is returned however the request
// ends, and one request checks each seller's identity once. Injected selection and execution only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError } from '@gyblos/buyer/free-chat';
import {
  executeBuyerFree,
  FreeSelectionFailure,
  type FreeBuyerDependencies,
  type FreeWinner,
} from '@gyblos/buyer/free-execution';
import { freeAdmission } from '@gyblos/buyer/free-parallel';
import { onceEachSeller } from '@gyblos/buyer/free-selection';
import { createReceiptWork } from '@gyblos/node/receipt-work';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';

const RESULT = {
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};
const INPUT = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 5,
};
// A real signed quote, so the request builds; the node ids only name the sellers here.
const QUOTE = (await (await freeSellerFixture()).request()).quote;
const winner = (nodeId: string): FreeWinner => ({ nodeId, quote: QUOTE });
const noSeller = () =>
  new FreeSelectionFailure({ ok: false, code: 'NO_ELIGIBLE_SELLER' } as never);

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

// A buyer over these sellers whose executions wait for `release` and may fail before sending.
function buyer(sellers: string[], limit = 2) {
  const admission = freeAdmission(limit);
  const ran: string[] = [];
  const started: (() => void)[] = [];
  let release = gate();
  let failBeforeSend = new Set<string>();
  const dependencies: FreeBuyerDependencies = {
    enter: () => admission.enter(),
    done: (chosen) => admission.done(chosen.nodeId),
    select: (excluded, signal) =>
      admission.select(excluded, signal, async (skip) => {
        const free = sellers.find((nodeId) => !skip.has(nodeId));
        if (!free) throw noSeller();
        return winner(free);
      }),
    async execute(chosen) {
      ran.push(chosen.nodeId);
      started.shift()?.();
      if (failBeforeSend.has(chosen.nodeId))
        throw new FreeClientError('UNAVAILABLE' as never, false);
      await release.opened;
      return RESULT;
    },
  };
  return {
    dependencies,
    ran,
    started: () => new Promise<void>((resolve) => started.push(resolve)),
    release: () => release.open(),
    reset: () => {
      release = gate();
    },
    failBeforeSend: (nodeIds: string[]) => {
      failBeforeSend = new Set(nodeIds);
    },
  };
}
const run = (dependencies: FreeBuyerDependencies, signal?: AbortSignal) =>
  executeBuyerFree(INPUT, dependencies, signal);

void test('two requests at once go to two different sellers', async () => {
  const host = buyer(['a', 'b']);
  const first = run(host.dependencies);
  await host.started();
  const second = run(host.dependencies);
  await host.started();
  host.release();
  assert.deepEqual(await Promise.all([first, second]), [RESULT, RESULT]);
  assert.deepEqual(host.ran, ['a', 'b']);
});

void test('with the only seller serving one request, the next is busy and the seller is not blamed', async () => {
  const host = buyer(['a']);
  const first = run(host.dependencies);
  await host.started();
  await assert.rejects(run(host.dependencies), { code: FREE_BUYER_CODES.BUSY });
  // A third request is refused at the door only while two are inside.
  host.release();
  await first;
  host.reset();
  const again = run(host.dependencies);
  await host.started();
  host.release();
  assert.deepEqual(await again, RESULT);
  assert.deepEqual(host.ran, ['a', 'a']);
});

void test('no more than the limit enter at once, and one at a time stays one at a time', async () => {
  const host = buyer(['a', 'b', 'c']);
  const first = run(host.dependencies);
  await host.started();
  const second = run(host.dependencies);
  await host.started();
  await assert.rejects(run(host.dependencies), { code: FREE_BUYER_CODES.BUSY });
  host.release();
  await Promise.all([first, second]);
  const single = buyer(['a', 'b'], 1);
  const only = run(single.dependencies);
  await single.started();
  await assert.rejects(run(single.dependencies), {
    code: FREE_BUYER_CODES.BUSY,
  });
  single.release();
  await only;
});

void test('a seller is handed back after a failure before sending, an abort, or an answer', async () => {
  const host = buyer(['a', 'b']);
  host.failBeforeSend(['a']);
  host.release();
  // `a` fails before the prompt left, so the request moves to `b`.
  assert.deepEqual(await run(host.dependencies), RESULT);
  assert.deepEqual(host.ran, ['a', 'b']);
  host.failBeforeSend([]);
  const controller = new AbortController();
  host.reset();
  const aborted = run(host.dependencies, controller.signal);
  await host.started();
  controller.abort();
  host.release();
  await assert.rejects(aborted);
  // Both sellers are free again: two requests at once still get two sellers.
  host.reset();
  const one = run(host.dependencies);
  await host.started();
  const two = run(host.dependencies);
  await host.started();
  host.release();
  await Promise.all([one, two]);
  assert.deepEqual(host.ran.slice(-2), ['a', 'b']);
});

void test('one request checks each seller identity once, keeping refusals and retrying aborted checks', async () => {
  let calls = 0;
  const verify = onceEachSeller(async (seller: { nodeId: string }) => {
    calls++;
    return seller.nodeId !== 'bad';
  });
  const seller = { nodeId: 'a', owner: 'o' };
  assert.equal(await verify(seller as never), true);
  assert.equal(await verify(seller as never), true);
  assert.equal(await verify({ nodeId: 'bad', owner: 'o' } as never), false);
  assert.equal(await verify({ nodeId: 'bad', owner: 'o' } as never), false);
  assert.equal(calls, 2);
  // Another owner for the same node is a different claim, checked on its own.
  assert.equal(await verify({ nodeId: 'a', owner: 'p' } as never), true);
  assert.equal(calls, 3);
  let failing = true;
  const flaky = onceEachSeller(async () => {
    if (failing) throw new Error('aborted');
    return true;
  });
  await assert.rejects(flaky(seller as never));
  failing = false;
  assert.equal(await flaky(seller as never), true);
});

void test('selections never overlap, and one that gives up waiting neither waits on nor breaks the line', async () => {
  const admission = freeAdmission(3);
  let running = 0;
  let most = 0;
  const first = gate();
  const pick = (hold?: Promise<void>) => async () => {
    running++;
    most = Math.max(most, running);
    await hold;
    running--;
    return { nodeId: 'a' };
  };
  const a = admission.select(
    new Set(),
    new AbortController().signal,
    pick(first.opened),
  );
  const leaving = new AbortController();
  const b = admission.select(new Set(), leaving.signal, pick());
  const c = admission.select(new Set(), new AbortController().signal, pick());
  leaving.abort();
  // B is released at once, while A still holds the turn.
  await assert.rejects(b, { name: 'AbortError' });
  assert.equal(running, 1);
  first.open();
  await Promise.all([a, c]);
  assert.equal(most, 1);
});

void test('with the only tool seller busy, a request that needs tools is told busy, not that none serves tools', async () => {
  const admission = freeAdmission(2);
  const signal = new AbortController().signal;
  await admission.select(new Set(), signal, async () => ({ nodeId: 'tools' }));
  await assert.rejects(
    admission.select(new Set(), signal, async () => {
      throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
    }),
    { code: FREE_BUYER_CODES.BUSY },
  );
  admission.done('tools');
  await assert.rejects(
    admission.select(new Set(), signal, async () => {
      throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
    }),
    { code: FREE_BUYER_CODES.UNAVAILABLE },
  );
});

void test('two receipts at once are both exchanged when the work has two slots', async () => {
  for (const [slots, dropped] of [
    [1, 1],
    [2, 0],
  ] as const) {
    const work = createReceiptWork(1000, slots);
    const hold = gate();
    const jobs = [work.run(() => hold.opened), work.run(() => hold.opened)];
    hold.open();
    await Promise.all(jobs);
    assert.equal(work.health().dropped, dropped);
    assert.equal(work.health().saved, 2 - dropped);
  }
});
