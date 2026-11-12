// Going back to the seller that served a conversation, and remembering sellers that fail while executing:
// the quote race waits briefly for the preferred seller and falls back at once when it refuses, a
// conversation keeps one key across turns, the memory of conversations is bounded, and a failed execution
// counts against its seller. Synthetic candidates and quotes only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { conversationKey } from '@gyblos/buyer/free-execution';
import { sellerFault, stickySellers } from '@gyblos/buyer/free-selection';
import { raceControlOffers } from '@gyblos/buyer/offer-race';
import {
  recordExecutionFailure,
  type LocalSellerStats,
} from '@gyblos/buyer/selection-stats';
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

const candidate = (nodeId: string) =>
  ({ nodeId, owner: `owner-${nodeId}`, downgrade: false }) as SellerCandidate;
const quote = (nodeId: string) => ({ nodeId }) as unknown as SignedOfferV2;
const after = (ms: number, nodeId: string, refuse = false) =>
  new Promise<SignedOfferV2>((resolve, reject) =>
    setTimeout(
      () => (refuse ? reject(new Error('refused')) : resolve(quote(nodeId))),
      ms,
    ),
  );
async function race(
  times: Record<string, number>,
  options: { preferred?: string; refuses?: string },
) {
  const winner = await raceControlOffers(
    Object.keys(times).map(candidate),
    (item) =>
      after(times[item.nodeId]!, item.nodeId, item.nodeId === options.refuses),
    { windowMs: 1000, preferMs: 100, ...options },
  );
  return winner?.candidate.nodeId;
}

void test('the quote race prefers the seller that served the conversation, briefly', async () => {
  // The preferred seller answers within the grace: it wins over a faster quote.
  assert.equal(await race({ a: 5, b: 40 }, { preferred: 'b' }), 'b');
  // It is too slow: the faster quote wins once the grace ends, long before the window.
  const started = performance.now();
  assert.equal(await race({ a: 5, b: 600 }, { preferred: 'b' }), 'a');
  assert.ok(performance.now() - started < 400);
  // It refuses: the waiting quote wins at once.
  assert.equal(
    await race({ a: 5, b: 30 }, { preferred: 'b', refuses: 'b' }),
    'a',
  );
  // It answers first, or there is no preference: the fastest wins as before.
  assert.equal(await race({ a: 30, b: 5 }, { preferred: 'b' }), 'b');
  assert.equal(await race({ a: 5, b: 30 }, {}), 'a');
  // The preferred seller is not a candidate this time: nothing waits.
  assert.equal(await race({ a: 5, b: 30 }, { preferred: 'z' }), 'a');
});

void test('a conversation keeps its key across turns; another model or system text is another conversation', () => {
  const opening = [
    { role: 'system' as const, content: 'be brief' },
    { role: 'user' as const, content: 'hi' },
  ];
  const first = conversationKey({ messages: opening, maxTokens: 5 });
  const later = conversationKey({
    messages: [
      ...opening,
      { role: 'assistant' as const, content: 'hello' },
      { role: 'user' as const, content: 'more' },
    ],
    maxTokens: 5,
  });
  assert.equal(first, later);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(
    conversationKey({
      messages: [{ ...opening[0]!, content: 'be long' }, opening[1]!],
      maxTokens: 5,
    }),
    first,
  );
  const model = {
    selection: { modelId: 'other', variant: null, quantization: null },
    maxTokens: 5,
  };
  assert.notEqual(
    conversationKey({ messages: opening, maxTokens: 5 }, model),
    first,
  );
});

void test('a conversation is remembered once its seller answered, forgotten when it failed, and bounded', () => {
  const sticky = stickySellers(2);
  sticky.chose('one', 'a');
  assert.equal(sticky.get('one'), undefined); // not yet answered
  sticky.served('a');
  assert.equal(sticky.get('one'), 'a');
  sticky.chose('one', 'a');
  sticky.forget('a'); // failed on the next turn
  assert.equal(sticky.get('one'), undefined);
  for (const [key, node] of [
    ['one', 'a'],
    ['two', 'b'],
    ['one', 'c'],
    ['three', 'd'],
  ] as const) {
    sticky.chose(key, node);
    sticky.served(node);
  }
  assert.equal(sticky.get('two'), undefined); // least recent, forgotten
  assert.deepEqual([sticky.get('one'), sticky.get('three')], ['c', 'd']);
});

void test("only the seller's failures count against it, not the buyer's own refusals", () => {
  const fault = (code: string, sent: boolean, remote = false) =>
    sellerFault(new FreeClientError(code as never, sent, remote));
  assert.equal(
    fault(FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE, true, true),
    true,
  );
  assert.equal(fault(FREE_EXECUTION_CODES.ENGINE, false, true), true);
  assert.equal(fault(FREE_EXECUTION_CODES.TIMEOUT, true), true);
  assert.equal(fault(FREE_EXECUTION_CODES.INVALID, true), true);
  // Before sending: the buyer's request, its relay rules or a quote that expired on its side.
  assert.equal(fault(FREE_EXECUTION_CODES.INVALID, false), false);
  assert.equal(fault(FREE_EXECUTION_CODES.PEER, false), false);
  assert.equal(fault(FREE_EXECUTION_CODES.EXPIRED, false), false);
  // The buyer's own fault, and a seller that was only busy.
  assert.equal(fault(FREE_EXECUTION_CODES.INTERNAL, true), false);
  assert.equal(fault(FREE_EXECUTION_CODES.BUSY, false, true), false);
  assert.equal(sellerFault(new Error('other')), false);
});

void test('when the window closes on a quote waiting for the preferred seller, nobody is cooled down', async () => {
  const expired: string[][] = [];
  const winner = await raceControlOffers(
    ['a', 'b', 'c'].map(candidate),
    (item) =>
      item.nodeId === 'a'
        ? after(80, 'a')
        : new Promise<SignedOfferV2>(() => {}),
    {
      windowMs: 100,
      preferMs: 500,
      preferred: 'b',
      onExpired: (pending) => expired.push(pending.map((item) => item.nodeId)),
    },
  );
  assert.equal(winner?.candidate.nodeId, 'a');
  assert.deepEqual(expired, []);
  // A preferred seller only at a lower level is not waited for.
  const lower = { ...candidate('b'), downgrade: true };
  const started = performance.now();
  const fast = await raceControlOffers(
    [candidate('a'), lower],
    (item) => after(item.nodeId === 'a' ? 5 : 300, item.nodeId),
    { windowMs: 1000, preferMs: 500, preferred: 'b' },
  );
  assert.equal(fast?.candidate.nodeId, 'a');
  assert.ok(performance.now() - started < 200);
});

void test('a failed execution counts a failure without a cooldown, keeping the rest of its history', () => {
  const stats = new Map<string, LocalSellerStats>([
    [
      'a',
      {
        successes: 4,
        failures: 1,
        latencyMs: 120,
        waitAccuracy: null,
        cooldownUntil: null,
        quotedWaitMs: null,
        observedWaitMs: null,
      },
    ],
  ]);
  recordExecutionFailure(stats, 'a');
  recordExecutionFailure(stats, 'new');
  assert.deepEqual(
    [
      stats.get('a')?.successes,
      stats.get('a')?.failures,
      stats.get('a')?.latencyMs,
    ],
    [4, 2, 120],
  );
  // Not cooled down: a buyer's only seller stays reachable after one failed answer.
  assert.equal(stats.get('a')?.cooldownUntil, null);
  assert.equal(stats.get('new')?.failures, 1);
});
