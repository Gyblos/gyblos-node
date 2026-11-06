// Exercises pure buyer seller selection with synthetic records and a seeded RNG; no I/O beyond reading its sources.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SELLER_BADGES,
  SELLER_SELECTION_CODES,
  SELLER_SELECTION_POLICY,
} from '@gyblos/core/constants';
import type { SellerSelectionInput } from '@gyblos/core/seller-selection';
import { DATA_RETENTION, REASONING_LEVELS } from '@gyblos/protocol/constants';

import {
  chosen,
  frequency,
  history,
  nodeId,
  NOW,
  request,
  seeded,
  select,
  seller,
} from './support/seller-selection-fixture';

const { OFF, LOW, MEDIUM, HIGH } = REASONING_LEVELS;

void test('seller selection never chooses a seller without the requested level', () => {
  const sellers = [
    seller(1, { reasoning: [OFF] }),
    seller(2, { reasoning: [OFF, LOW, MEDIUM] }),
    seller(3),
    seller(4, { input: '50', output: '50' }),
  ];
  for (let seed = 1; seed <= 200; seed++)
    for (const candidate of chosen(select(sellers, { random: seeded(seed) }))) {
      assert.ok([nodeId(3), nodeId(4)].includes(candidate.nodeId));
      assert.equal(candidate.reasoning, HIGH);
      assert.equal(candidate.downgrade, false);
    }
});
void test('seller selection never downgrades silently', () => {
  const sellers = [seller(1, { reasoning: [MEDIUM] }), seller(2)];
  assert.deepEqual(select(sellers, { request: request({ reasoning: LOW }) }), {
    ok: false,
    code: SELLER_SELECTION_CODES.LEVEL_UNSUPPORTED,
  });
  assert.deepEqual(select([], { request: request() }), {
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  });
});
void test('permitted downgrade fills from the closest lower level down to the floor after exact candidates', () => {
  const sellers = [
    seller(1),
    seller(2, { reasoning: [MEDIUM] }),
    seller(3, { reasoning: [LOW] }),
    seller(4, { reasoning: [MEDIUM], modelId: 'other-model' }),
    seller(5, { reasoning: [MEDIUM], input: '0', output: '0' }),
  ];
  const permitted = request({ lowestReasoning: OFF });
  for (let seed = 1; seed <= 100; seed++) {
    const candidates = chosen(
      select(sellers, { request: permitted, random: seeded(seed) }),
    );
    assert.equal(candidates[0]?.nodeId, nodeId(1));
    assert.equal(candidates[0]?.downgrade, false);
    assert.deepEqual(
      candidates.slice(1).map((item) => [item.reasoning, item.downgrade]),
      [
        [MEDIUM, true],
        [MEDIUM, true],
      ],
    );
    assert.ok(
      !candidates.some((item) => [nodeId(3), nodeId(4)].includes(item.nodeId)),
    );
  }
  const overlapping = chosen(
    select(
      [
        seller(1, { reasoning: [MEDIUM, HIGH] }),
        seller(2, { reasoning: [MEDIUM] }),
      ],
      {
        request: permitted,
      },
    ),
  );
  assert.deepEqual(
    overlapping.map((item) => [item.nodeId, item.reasoning, item.downgrade]),
    [
      [nodeId(1), HIGH, false],
      [nodeId(2), MEDIUM, true],
    ],
  );
  const exactOnly = chosen(
    select([seller(1), seller(2, { reasoning: [MEDIUM] })], {
      request: permitted,
      count: 1,
    }),
  );
  assert.deepEqual(
    exactOnly.map((item) => item.nodeId),
    [nodeId(1)],
  );
  // Remaining slots continue to farther levels, closest first, each seller at most once.
  const ladder = [
    seller(1),
    seller(2, { reasoning: [MEDIUM, LOW] }),
    seller(3, { reasoning: [LOW] }),
    seller(6, { reasoning: [OFF] }),
    seller(7, { reasoning: [LOW, OFF] }),
    seller(4, { reasoning: [LOW], modelId: 'other-model' }),
  ];
  for (let seed = 1; seed <= 50; seed++) {
    const filled = chosen(
      select(ladder, { request: permitted, count: 5, random: seeded(seed) }),
    );
    assert.deepEqual(
      filled.map((item) => item.reasoning),
      [HIGH, MEDIUM, LOW, LOW, OFF],
    );
    assert.deepEqual(filled.map((item) => item.nodeId).slice(0, 2), [
      nodeId(1),
      nodeId(2),
    ]);
    assert.deepEqual(
      new Set(filled.slice(2, 4).map((item) => item.nodeId)),
      new Set([nodeId(3), nodeId(7)]),
    );
    assert.equal(filled[4]?.nodeId, nodeId(6));
  }
  const floor = select([seller(3, { reasoning: [LOW] })], {
    request: request({ lowestReasoning: MEDIUM }),
  });
  assert.deepEqual(floor, {
    ok: false,
    code: SELLER_SELECTION_CODES.LEVEL_UNSUPPORTED,
  });
});
void test('a pinned seller is the only candidate when it passes and a typed refusal otherwise', () => {
  const sellers = [
    seller(1),
    seller(2, { input: '99' }),
    seller(3, { reasoning: [OFF] }),
  ];
  const pinned = chosen(select(sellers, { pinnedNodeId: nodeId(2) }));
  assert.deepEqual(
    pinned.map((item) => [item.nodeId, item.exploration]),
    [[nodeId(2), false]],
  );
  for (const pinnedNodeId of [nodeId(3), nodeId(9)])
    assert.deepEqual(select(sellers, { pinnedNodeId }), {
      ok: false,
      code: SELLER_SELECTION_CODES.PINNED_REJECTED,
    });
  const lowered = chosen(
    select(sellers, {
      pinnedNodeId: nodeId(3),
      request: request({ lowestReasoning: OFF }),
    }),
  );
  assert.deepEqual(
    lowered.map((item) => [item.reasoning, item.downgrade]),
    [[OFF, true]],
  );
  // Cooldown alone yields its own code and the time it ends, so the app can say when it returns.
  const cooling = new Map([[nodeId(2), history({ cooldownUntil: NOW + 1 })]]);
  assert.deepEqual(
    select(sellers, { pinnedNodeId: nodeId(2), stats: cooling }),
    {
      ok: false,
      code: SELLER_SELECTION_CODES.PINNED_IN_COOLDOWN,
      cooldownUntil: NOW + 1,
    },
  );
  const staleAndCooling = new Map([
    [nodeId(4), history({ cooldownUntil: NOW + 1 })],
  ]);
  assert.deepEqual(
    select([...sellers, seller(4, { presence: 'stale' })], {
      pinnedNodeId: nodeId(4),
      stats: staleAndCooling,
    }),
    { ok: false, code: SELLER_SELECTION_CODES.PINNED_REJECTED },
  );
});
void test('weights favor cheaper sellers without always choosing the same one', () => {
  const sellers = [seller(1), seller(2, { input: '3', output: '6' })];
  const counts = frequency(4000, (seed) =>
    chosen(select(sellers, { random: seeded(seed), count: 1 })).map(
      (item) => item.nodeId,
    ),
  );
  const cheap = (counts.get(nodeId(1)) ?? 0) / 4000;
  // Inverse-square price: 1/1 versus 1/9 gives the cheaper seller 90%.
  assert.ok(cheap > 0.87 && cheap < 0.93, String(cheap));
  assert.ok((counts.get(nodeId(2)) ?? 0) > 0);
});
void test('free offers weigh as a capped price and all-free pools sample evenly', () => {
  const mixed = [seller(1, { input: '0', output: '0' }), seller(2)];
  const counts = frequency(4000, (seed) =>
    chosen(select(mixed, { random: seeded(seed), count: 1 })).map(
      (item) => item.nodeId,
    ),
  );
  const free = (counts.get(nodeId(1)) ?? 0) / 4000;
  // Free weighs twice the cheapest paid offer, so about 67%.
  assert.ok(free > 0.64 && free < 0.69, String(free));
  const allFree = [1, 2].map((index) =>
    seller(index, { input: '0', output: '0' }),
  );
  const even = frequency(4000, (seed) =>
    chosen(select(allFree, { random: seeded(seed), count: 1 })).map(
      (item) => item.nodeId,
    ),
  );
  const share = (even.get(nodeId(1)) ?? 0) / 4000;
  assert.ok(share > 0.46 && share < 0.54, String(share));
  const zeroBudget = chosen(
    select([seller(1, { input: '0', output: '0' }), seller(2)], {
      request: request({ maxAtomic: '0' }),
    }),
  );
  assert.deepEqual(
    zeroBudget.map((item) => [item.nodeId, item.free]),
    [[nodeId(1), true]],
  );
});
void test('one slot is reserved for a seller with no local history', () => {
  const sellers = [1, 2, 3, 4].map((index) => seller(index));
  sellers.push(seller(5, { input: '50', output: '50' }));
  const stats = new Map(
    [1, 2, 3, 4].map((index) => [nodeId(index), history()]),
  );
  for (let seed = 1; seed <= 100; seed++) {
    const candidates = chosen(select(sellers, { stats, random: seeded(seed) }));
    assert.equal(candidates.length, 3);
    assert.deepEqual(
      candidates
        .filter((item) => item.nodeId === nodeId(5))
        .map((item) => item.exploration),
      [true],
    );
  }
  for (let seed = 1; seed <= 50; seed++)
    assert.ok(
      !chosen(select(sellers, { stats, count: 1, random: seeded(seed) })).some(
        (item) => item.exploration,
      ),
    );
});
void test('local reputation and open channels shift weight within bounds', () => {
  const sellers = [seller(1), seller(2)];
  const stats = new Map([
    [
      nodeId(1),
      history({
        successes: 0,
        failures: 1000,
        latencyMs: 60_000,
        waitAccuracy: 0,
      }),
    ],
    [nodeId(2), history()],
  ]);
  const counts = frequency(4000, (seed) =>
    chosen(select(sellers, { stats, random: seeded(seed), count: 1 })).map(
      (item) => item.nodeId,
    ),
  );
  const poor = (counts.get(nodeId(1)) ?? 0) / 4000;
  // Bounded factors: the 0.03 floor versus 6/7 * 1 * 0.875 (wait accuracy shrunk over five samples)
  // gives about 4%, never zero.
  assert.ok(poor > 0.025 && poor < 0.055, String(poor));
  const channel = frequency(4000, (seed) =>
    chosen(
      select([seller(1, { openChannel: true }), seller(2)], {
        random: seeded(seed),
        count: 1,
      }),
    ).map((item) => item.nodeId),
  );
  const open = (channel.get(nodeId(1)) ?? 0) / 4000;
  // Price factor 0.8 means weight 1 / 0.64, about 61%.
  assert.ok(open > 0.58 && open < 0.64, String(open));
});
void test('hard filters exclude cooldown, stale, withdrawn, policy, badge and price failures', () => {
  const excluded = [
    seller(1, { presence: 'stale' }),
    seller(2, { presence: 'none' }),
    seller(3, { withdrawn: true }),
    seller(4, { catalogExpired: true }),
    seller(5, { retention: DATA_RETENTION.MAY_RETAIN }),
    seller(6, { badge: SELLER_BADGES.DECLARED_USAGE }),
    seller(7, { input: '101000000' }),
    seller(8, { input: '60000000', output: '50000000' }),
    seller(9),
  ];
  const stats = new Map([
    [nodeId(9), history({ cooldownUntil: NOW + 1 })],
    [nodeId(10), history({ cooldownUntil: NOW })],
  ]);
  const strict = request({
    minimumBadge: SELLER_BADGES.MEASURABLE_USAGE,
    maxAtomic: '100',
    priceCeilings: {
      inputAtomicPerMtok: '100000000',
      outputAtomicPerMtok: '100000000',
    },
  });
  const result = select([...excluded, seller(10)], { request: strict, stats });
  assert.deepEqual(
    chosen(result).map((item) => item.nodeId),
    [nodeId(10)],
  );
  // Sellers 7 and 8 offer the model above the budget, so the failure names the price.
  assert.deepEqual(select(excluded, { request: strict, stats }), {
    ok: false,
    code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET,
  });
  const unpriced = excluded.filter((_, index) => index !== 6 && index !== 7);
  assert.deepEqual(select(unpriced, { request: strict, stats }), {
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  });
});
void test('selection is deterministic for a seed and varies across seeds', () => {
  const sellers = [1, 2, 3, 4, 5, 6].map((index) =>
    seller(index, { input: String(index) }),
  );
  const run = (seed: number) =>
    chosen(select(sellers, { random: seeded(seed) })).map(
      (item) => item.nodeId,
    );
  assert.deepEqual(run(7), run(7));
  assert.ok(new Set([1, 2, 3, 4, 5].map((seed) => run(seed).join())).size > 1);
});
void test('candidate count is bounded and invalid input returns only a typed code', () => {
  const sellers = [1, 2, 3, 4, 5, 6, 7].map((index) => seller(index));
  assert.equal(
    chosen(select(sellers)).length,
    SELLER_SELECTION_POLICY.defaultCandidates,
  );
  assert.equal(
    chosen(select(sellers, { count: SELLER_SELECTION_POLICY.maxCandidates }))
      .length,
    SELLER_SELECTION_POLICY.maxCandidates,
  );
  assert.equal(chosen(select(sellers.slice(0, 2), { count: 5 })).length, 2);
  const invalid = { ok: false, code: SELLER_SELECTION_CODES.INVALID };
  for (const overrides of [
    { count: 0 },
    { count: SELLER_SELECTION_POLICY.maxCandidates + 1 },
    { count: 1.5 },
    { random: () => 1 },
    { now: -1 },
    { request: request({ lowestReasoning: HIGH }) },
    { request: request({ maxAtomic: '01' }) },
    { request: request({ retention: [] }) },
    { stats: new Map([[nodeId(1), history({ waitAccuracy: 2 })]]) },
    { sellers: [seller(1), seller(1)] },
  ] satisfies Partial<SellerSelectionInput>[])
    assert.deepEqual(select(sellers, overrides), invalid);
});
void test('seller selection source reads no global clock, randomness, filesystem or network', async () => {
  const directory = new URL('../packages/core/src/', import.meta.url);
  const modules = (await readdir(directory)).filter((name) =>
    name.startsWith('seller-selection'),
  );
  assert.ok(modules.includes('seller-selection.ts'));
  assert.ok(modules.includes('seller-selection-input.ts'));
  for (const name of modules) {
    const source = await readFile(new URL(name, directory), 'utf8');
    for (const forbidden of [
      'Date.now',
      'new Date',
      'Math.random',
      'node:',
      'fetch(',
      'performance.',
    ])
      assert.equal(source.includes(forbidden), false, `${name}: ${forbidden}`);
  }
});
