// Tests parallel quote ordering and cancellation independently of sockets and payment adapters.
import assert from 'node:assert/strict';
import test from 'node:test';

import { raceControlOffers } from '@gyblos/buyer/offer-race';
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';

function candidate(nodeId: string, downgrade: boolean): SellerCandidate {
  return {
    nodeId,
    owner: nodeId,
    listing: {} as SellerCandidate['listing'],
    reasoning: downgrade ? REASONING_LEVELS.OFF : REASONING_LEVELS.LOW,
    downgrade,
    exploration: false,
    sticky: false,
    free: true,
    openChannel: false,
  };
}
const quote = { offer: {}, signature: '' } as SignedOfferV2;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
void test('parallel race never accepts a downgrade over a pending exact offer', async () => {
  const exact = deferred<SignedOfferV2>();
  const lower = deferred<SignedOfferV2>();
  const started: string[] = [];
  let done = false;
  const result = raceControlOffers(
    [candidate('exact', false), candidate('lower', true)],
    async (item) => {
      started.push(item.nodeId);
      return item.downgrade ? lower.promise : exact.promise;
    },
    { windowMs: 1000 },
  ).then((value) => {
    done = true;
    return value;
  });
  lower.resolve(quote);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['exact', 'lower']);
  assert.equal(done, false);
  exact.resolve(quote);
  assert.equal((await result)?.candidate.nodeId, 'exact');
});
void test('a buffered downgrade can win only after every exact candidate refuses', async () => {
  const first = deferred<SignedOfferV2>();
  const second = deferred<SignedOfferV2>();
  let done = false;
  const result = raceControlOffers(
    [
      candidate('one', false),
      candidate('two', false),
      candidate('lower', true),
    ],
    (item) =>
      item.nodeId === 'one'
        ? first.promise
        : item.nodeId === 'two'
          ? second.promise
          : Promise.resolve(quote),
  ).then((value) => {
    done = true;
    return value;
  });
  first.reject(new Error('busy'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  second.reject(new Error('busy'));
  assert.equal((await result)?.candidate.nodeId, 'lower');
});
void test('window expiry with a pending exact candidate refuses buffered downgrade and aborts losers', async () => {
  let signal: AbortSignal | undefined;
  const result = await raceControlOffers(
    [candidate('exact', false), candidate('lower', true)],
    async (item, current) => {
      signal = current;
      return item.downgrade ? quote : new Promise(() => {});
    },
    { windowMs: 20 },
  );
  assert.equal(result, undefined);
  assert.equal(signal?.aborted, true);
});
void test('first validated exact quote wins and caller cancellation publishes no late quote', async () => {
  const slow = deferred<SignedOfferV2>();
  const fast = await raceControlOffers(
    [candidate('slow', false), candidate('fast', false)],
    async (item) => (item.nodeId === 'fast' ? quote : slow.promise),
  );
  assert.equal(fast?.candidate.nodeId, 'fast');
  slow.resolve(quote);
  const controller = new AbortController();
  const pending = deferred<SignedOfferV2>();
  const result = raceControlOffers(
    [candidate('cancelled', false)],
    () => pending.promise,
    { signal: controller.signal },
  );
  controller.abort();
  pending.resolve(quote);
  assert.equal(await result, undefined);
});
void test('onExpired reports only candidates still unanswered when the window closes', async () => {
  const expired: string[][] = [];
  const onExpired = (pending: readonly SellerCandidate[]) =>
    expired.push(pending.map((item) => item.nodeId));
  // A winner, an all-refused race and a caller abort never report.
  await raceControlOffers([candidate('fast', false)], async () => quote, {
    windowMs: 1000,
    onExpired,
  });
  await raceControlOffers(
    [candidate('no', false)],
    async () => {
      throw new Error('refused');
    },
    { windowMs: 1000, onExpired },
  );
  const caller = new AbortController();
  const aborted = raceControlOffers(
    [candidate('held', false)],
    () => new Promise<SignedOfferV2>(() => {}),
    { windowMs: 1000, onExpired, signal: caller.signal },
  );
  caller.abort();
  await aborted;
  assert.deepEqual(expired, []);
  // A refused candidate is not reported with the silent one.
  await raceControlOffers(
    [candidate('silent', false), candidate('refused', false)],
    async (item) => {
      if (item.nodeId === 'refused') throw new Error('refused');
      return new Promise<SignedOfferV2>(() => {});
    },
    { windowMs: 20, onExpired },
  );
  assert.deepEqual(expired, [['silent']]);
});
