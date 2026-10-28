// Checks that the previous seller keeps the first slot only while it passes filters and stays competitive.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import type { SellerSelectionInput } from '@gyblos/core/seller-selection';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';

import {
  chosen,
  history,
  nodeId,
  NOW,
  request,
  seeded,
  select,
  seller,
} from './support/seller-selection-fixture';

const { MEDIUM, HIGH } = REASONING_LEVELS;
const runs = (
  sellers: ReturnType<typeof seller>[],
  overrides: Partial<SellerSelectionInput>,
) =>
  Array.from({ length: 100 }, (_, index) =>
    chosen(select(sellers, { ...overrides, random: seeded(index + 1) })),
  );

void test('a competitive previous seller takes the first slot, flagged sticky', () => {
  const sellers = [1, 2, 3, 4, 5].map((index) =>
    seller(index, { input: '4', output: '6' }),
  );
  // Seller 3 costs 11 against 10: weight (10 / 11)^2 = 0.83 of the best, inside the 0.8 margin.
  sellers[2] = seller(3, { input: '5', output: '6' });
  for (const candidates of runs(sellers, { previousSeller: nodeId(3) })) {
    assert.equal(candidates[0]?.nodeId, nodeId(3));
    assert.equal(candidates[0]?.sticky, true);
    assert.equal(candidates.length, 3);
    assert.ok(candidates.slice(1).every((item) => !item.sticky));
    assert.equal(new Set(candidates.map((item) => item.nodeId)).size, 3);
  }
  const single = chosen(
    select(sellers, { previousSeller: nodeId(5), count: 1, random: seeded(9) }),
  );
  assert.deepEqual(
    single.map((item) => [item.nodeId, item.sticky]),
    [[nodeId(5), true]],
  );
});
void test('a previous seller is not kept when it is filtered, cooling down, too costly or a downgrade', () => {
  const base = [1, 2, 3].map((index) => seller(index));
  const notKept = (
    sellers: ReturnType<typeof seller>[],
    overrides: Partial<SellerSelectionInput>,
  ) => {
    let first = 0;
    for (const candidates of runs(sellers, overrides)) {
      assert.ok(candidates.every((item) => !item.sticky));
      if (candidates[0]?.nodeId === nodeId(9)) first++;
    }
    return first;
  };
  assert.equal(
    notKept([...base, seller(9, { presence: 'stale' })], {
      previousSeller: nodeId(9),
    }),
    0,
  );
  assert.equal(
    notKept([...base, seller(9)], {
      previousSeller: nodeId(9),
      stats: new Map([[nodeId(9), history({ cooldownUntil: NOW + 1 })]]),
    }),
    0,
  );
  // Twice the price is a quarter of the best weight: sampled normally, not pinned first.
  assert.ok(
    notKept([...base, seller(9, { input: '2', output: '4' })], {
      previousSeller: nodeId(9),
    }) < 50,
  );
  assert.equal(
    notKept([...base, seller(9, { reasoning: [MEDIUM] })], {
      previousSeller: nodeId(9),
      request: request({ reasoning: HIGH, lowestReasoning: MEDIUM }),
    }),
    0,
  );
  assert.deepEqual(select(base, { previousSeller: 7 as unknown as string }), {
    ok: false,
    code: SELLER_SELECTION_CODES.INVALID,
  });
});

void test('a fresh sticky seller consumes the only newcomer slot when history is available', () => {
  const seasoned = [seller(1), seller(2), seller(3)];
  const fresh = [4, 5].map((index) =>
    seller(index, { input: '0', output: '1' }),
  );
  const stats = new Map(
    seasoned.map((item) => [item.catalog.nodeId, history()]),
  );
  for (let seed = 1; seed <= 100; seed++) {
    const candidates = chosen(
      select([...seasoned, ...fresh], {
        stats,
        previousSeller: nodeId(4),
        count: 3,
        random: seeded(seed),
      }),
    );
    assert.equal(candidates[0]?.nodeId, nodeId(4));
    assert.equal(candidates[0]?.sticky, true);
    assert.equal(candidates.length, 3);
    assert.equal(
      candidates.filter((item) => !stats.has(item.nodeId)).length,
      1,
    );
  }
});
