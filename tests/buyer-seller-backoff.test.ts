// A seller that keeps failing is cooled down longer each time: 30 s, then twice as long after each further
// failure in a row, at most ten minutes, and back to normal on its first good quote. Without a backoff
// (paid paths), every failure cools for 30 s as before. The free buyer's terminal line says when it
// tries again. Pure functions and an injected clock; no network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sellerFailureLine } from '@gyblos/buyer-app/free-main';
import {
  BUYER_SELECTION,
  ERROR_DIAGNOSTICS,
  SELLER_FAILURE_PHASES,
} from '@gyblos/buyer/constants';
import {
  backoffFor,
  createSellerBackoff,
} from '@gyblos/buyer/selection-backoff';
import { recordQuote } from '@gyblos/buyer/selection-snapshots';
import {
  selectionStats,
  type LocalSellerStats,
} from '@gyblos/buyer/selection-stats';
import { DEVNET_USDC } from '@gyblos/config';
import { setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

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
  const failure: Parameters<typeof sellerFailureLine>[0] = {
    nodeId: NODE,
    phase: SELLER_FAILURE_PHASES.CONNECT,
    code: ERROR_DIAGNOSTICS.TIMEOUT,
  };
  assert.doesNotMatch(sellerFailureLine(failure, 0), /retry_in/);
  assert.match(
    sellerFailureLine({ ...failure, retryAt: 120_400 }, 400),
    / retry_in=120s$/,
  );
});

void test('no growing cooldown for a cancelled request, the pinned seller or the only seller', () => {
  const backoff = createSellerBackoff();
  const alternative = 'b'.repeat(64);
  assert.equal(backoffFor(backoff, {}, NODE, alternative), backoff);
  assert.equal(backoffFor(undefined, {}, NODE, alternative), undefined);
  assert.equal(backoffFor(backoff, {}, NODE), undefined);
  assert.equal(backoffFor(backoff, {}, NODE, NODE), undefined);
  assert.equal(
    backoffFor(backoff, { pinnedNodeId: NODE }, NODE, alternative),
    undefined,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(
    backoffFor(backoff, {}, NODE, alternative, cancelled.signal),
    undefined,
  );
  // Without an alternative the cooldown stays 30 s and the count does not grow.
  const stats = new Map<string, LocalSellerStats>();
  for (let index = 0; index < 3; index++)
    assert.equal(
      recordQuote(stats, NODE, false, 0, 0, backoffFor(backoff, {}, NODE)),
      30_000,
    );
  assert.equal(recordQuote(stats, NODE, false, 0, 0, backoff), 30_000);
});

void test('a long cooldown saved by an earlier run is cut to 30 s on load', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-backoff-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { GYBLOS_HOME: home };
  // setupRole reads the process environment: point it at the temporary home, never the default one.
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
  });
  await setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC });
  const saved = await selectionStats(environment);
  const long = Date.now() + BUYER_SELECTION.maxCooldownMs;
  saved.rows.set(NODE, {
    successes: 0,
    failures: 5,
    latencyMs: null,
    waitAccuracy: null,
    cooldownUntil: long,
    quotedWaitMs: null,
    observedWaitMs: null,
  });
  await saved.save();
  const loaded = (await selectionStats(environment)).rows.get(NODE)!;
  assert.ok(loaded.cooldownUntil! <= Date.now() + BUYER_SELECTION.cooldownMs);
  assert.ok(loaded.cooldownUntil! > Date.now());
});
