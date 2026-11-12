// Going back to the seller that served a conversation, and remembering sellers that fail while executing:
// the quote race waits briefly for the preferred seller and falls back at once when it refuses, a
// conversation keeps one key across turns, the memory of conversations is bounded, and a failed execution
// counts against its seller. Synthetic candidates and quotes only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { conversationKey } from '@gyblos/buyer/free-execution';
import { stickySellers } from '@gyblos/buyer/free-selection';
import { raceControlOffers } from '@gyblos/buyer/offer-race';
import {
  recordExecutionFailure,
  type LocalSellerStats,
} from '@gyblos/buyer/selection-stats';
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';

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

void test('the remembered conversations are bounded, the least recent forgotten first', () => {
  const sticky = stickySellers(2);
  sticky.remember('one', 'a');
  sticky.remember('two', 'b');
  sticky.remember('one', 'c'); // refreshed, now the most recent
  sticky.remember('three', 'd');
  assert.equal(sticky.get('two'), undefined);
  assert.equal(sticky.get('one'), 'c');
  assert.equal(sticky.get('three'), 'd');
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
