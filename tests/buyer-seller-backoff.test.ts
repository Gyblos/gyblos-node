// A seller that keeps failing is cooled down longer each time: 30 s, then twice as long after each further
// failure in a row, at most ten minutes, and back to normal on its first good quote. Without a backoff
// (paid paths), every failure cools for 30 s as before. The free buyer's terminal line says when it
// tries again. Pure functions and an injected clock; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { sellerFailureLine } from '@gyblos/buyer/free-main';
import { createSellerBackoff } from '@gyblos/buyer/selection-backoff';
import { recordQuote } from '@gyblos/buyer/selection-snapshots';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';

const NODE = 'a'.repeat(64);

void test('each failure in a row doubles the cooldown, up to ten minutes', () => {
  const stats = new Map<string, LocalSellerStats>();
  const backoff = createSellerBackoff();
  const cooldowns = Array.from({ length: 8 }, () =>
    recordQuote(stats, NODE, false, 0, 0, backoff)!,
  );
  assert.deepEqual(
    cooldowns.map((until) => until / 1000),
    [30, 60, 120, 240, 480, 600, 600, 600],
  );
  assert.equal(stats.get(NODE)?.cooldownUntil, BUYER_SELECTION.maxCooldownMs);
});

void test('a good quote clears the streak, and other sellers keep their own', () => {
  const stats = new Map<string, LocalSellerStats>();
  const backoff = createSellerBackoff();
  recordQuote(stats, NODE, false, 0, 0, backoff);
  recordQuote(stats, NODE, false, 0, 0, backoff);
  assert.equal(
    recordQuote(stats, 'b'.repeat(64), false, 0, 0, backoff),
    30_000,
  );
  assert.equal(recordQuote(stats, NODE, true, 5, 0, backoff), null);
  assert.equal(stats.get(NODE)?.cooldownUntil, null);
  assert.equal(recordQuote(stats, NODE, false, 0, 0, backoff), 30_000);
});

void test('without a backoff every failure cools for 30 s, as before', () => {
  const stats = new Map<string, LocalSellerStats>();
  for (let index = 0; index < 4; index++)
    assert.equal(recordQuote(stats, NODE, false, 0, 1000), 31_000);
});

void test('the failure line says when the seller is tried again', () => {
  const failure = {
    nodeId: NODE,
    phase: 'connect',
    code: 'REQUEST_TIMEOUT',
  } as const;
  assert.doesNotMatch(sellerFailureLine(failure as never, 0), /retry_in/);
  assert.match(
    sellerFailureLine({ ...failure, retryAt: 120_400 } as never, 400),
    / retry_in=120s$/,
  );
});
