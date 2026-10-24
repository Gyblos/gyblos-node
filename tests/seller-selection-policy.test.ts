// Checks the injectable selection policy and how local reputation bounds price; seeded RNG, no I/O.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SELLER_SELECTION_CODES,
  SELLER_SELECTION_POLICY,
} from '@gyblos/core/constants';
import type {
  SellerSelectionInput,
  SellerStats,
} from '@gyblos/core/seller-selection';

import {
  chosen,
  frequency,
  history,
  nodeId,
  seeded,
  select,
  seller,
} from './support/seller-selection-fixture.js';

const RUNS = 2000;
function share(
  sellers: ReturnType<typeof seller>[],
  overrides: Partial<SellerSelectionInput>,
  target: string,
) {
  let runs = 0;
  for (let seed = 1; seed <= RUNS; seed++)
    if (
      chosen(select(sellers, { ...overrides, random: seeded(seed) })).some(
        (item) => item.nodeId === target,
      )
    )
      runs++;
  return runs / RUNS;
}

void test('a caller-supplied policy replaces the default and is validated', () => {
  const sellers = [1, 2, 3, 4].map((index) => seller(index));
  const policy = { ...SELLER_SELECTION_POLICY, defaultCandidates: 1 };
  assert.equal(chosen(select(sellers, { policy })).length, 1);
  assert.equal(
    chosen(select(sellers)).length,
    SELLER_SELECTION_POLICY.defaultCandidates,
  );
  const invalid = { ok: false, code: SELLER_SELECTION_CODES.INVALID };
  for (const patch of [
    { reputationMin: -1 },
    { reputationMin: 3 },
    { defaultCandidates: 6 },
    { maxCandidates: 0.5 },
    { freeWeightMultiple: Number.NaN },
    { openChannelPriceFactor: 0 },
    { stickyWeightFraction: 2 },
  ])
    assert.deepEqual(
      select(sellers, { policy: { ...SELLER_SELECTION_POLICY, ...patch } }),
      invalid,
    );
  const { reputationMax: _omitted, ...partial } = SELLER_SELECTION_POLICY;
  assert.deepEqual(
    select(sellers, { policy: partial as typeof SELLER_SELECTION_POLICY }),
    invalid,
  );
  assert.deepEqual(
    select(sellers, { policy: null as unknown as typeof policy }),
    invalid,
  );
});
void test('a cheap seller with 50 straight failures appears in at most 10% of selections', () => {
  const honest = Array.from({ length: 10 }, (_, index) => seller(index + 1));
  const cheap = seller(50, { input: '0', output: '1' });
  const stats = new Map<string, SellerStats>(
    honest.map((item) => [item.catalog.nodeId, history({ successes: 20 })]),
  );
  stats.set(
    nodeId(50),
    history({
      successes: 0,
      failures: 50,
      latencyMs: null,
      waitAccuracy: null,
    }),
  );
  const appears = share([...honest, cheap], { stats }, nodeId(50));
  assert.ok(appears <= 0.1, String(appears));
});
void test('missing wait accuracy is neutral and few latency samples are shrunk', () => {
  const pair = [seller(1), seller(2)];
  const odds = (first: SellerStats, second: SellerStats) => {
    const counts = frequency(4000, (seed) =>
      chosen(
        select(pair, {
          stats: new Map([
            [nodeId(1), first],
            [nodeId(2), second],
          ]),
          random: seeded(seed),
          count: 1,
        }),
      ).map((item) => item.nodeId),
    );
    return (counts.get(nodeId(1)) ?? 0) / 4000;
  };
  const many = { successes: 50 };
  // Unknown accuracy sits between a perfect and a never-accurate record.
  const unknown = odds(
    history({ ...many, waitAccuracy: null }),
    history({ ...many, waitAccuracy: 1 }),
  );
  assert.ok(unknown < 0.47, String(unknown));
  const versusWorst = odds(
    history({ ...many, waitAccuracy: null }),
    history({ ...many, waitAccuracy: 0 }),
  );
  assert.ok(versusWorst > 0.53, String(versusWorst));
  // One fast sample barely moves the odds; fifty do.
  const fewFast = odds(
    history({ successes: 1, latencyMs: 100 }),
    history({ successes: 1, latencyMs: 1000 }),
  );
  assert.ok(fewFast < 0.56, String(fewFast));
  const manyFast = odds(
    history({ ...many, latencyMs: 100 }),
    history({ ...many, latencyMs: 1000 }),
  );
  assert.ok(manyFast > 0.56, String(manyFast));
});

void test('unsafe derived weights and sampling totals return the typed invalid code', () => {
  const sellers = [1, 2].map((index) =>
    seller(index, { input: '0', output: '0' }),
  );
  for (const reputation of [1, 2]) {
    assert.deepEqual(
      select(sellers, {
        count: 1,
        policy: {
          ...SELLER_SELECTION_POLICY,
          freeWeightMultiple: Number.MAX_VALUE,
          reputationMin: reputation,
          reputationMax: reputation,
        },
      }),
      { ok: false, code: SELLER_SELECTION_CODES.INVALID },
    );
  }
});
