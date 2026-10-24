// Simulates cheap-identity abuse against seller selection (Sybils, whitewashing, one owner many nodes).
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SellerStats } from '@gyblos/core/seller-selection';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';

import {
  chosen,
  history,
  nodeId,
  request,
  seeded,
  select,
  seller,
} from './support/seller-selection-fixture.js';

const SYBIL_START = 100;
const isSybil = (id: string) => Number.parseInt(id, 16) >= SYBIL_START;

void test('1,000 fresh Sybils take at most the exploration slot from a buyer with history', () => {
  const seasoned = Array.from({ length: 10 }, (_, index) => seller(index + 1));
  const sybils = Array.from({ length: 1000 }, (_, index) =>
    seller(index + SYBIL_START),
  );
  const stats = new Map<string, SellerStats>(
    seasoned.map((item) => [item.catalog.nodeId, history({ successes: 20 })]),
  );
  for (const count of [3, 5]) {
    let slots = 0;
    let sybilSlots = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const candidates = chosen(
        select([...seasoned, ...sybils], {
          stats,
          count,
          random: seeded(seed),
        }),
      );
      const taken = candidates.filter((item) => isSybil(item.nodeId));
      assert.ok(taken.every((item) => item.exploration));
      assert.ok(taken.length <= 1);
      slots += candidates.length;
      sybilSlots += taken.length;
    }
    assert.ok(sybilSlots / slots <= 1 / count, `${count}: ${sybilSlots}`);
  }
});
void test('a whitewashed NodeId does not outrank a seller with one failure', () => {
  // Seller 1 failed once; seller 4 is the same operator under a new NodeId with no history.
  const sellers = [seller(1), seller(2), seller(3), seller(4)];
  const stats = new Map([
    [nodeId(1), history({ successes: 0, failures: 1 })],
    [nodeId(2), history()],
    [nodeId(3), history()],
  ]);
  for (let seed = 1; seed <= 200; seed++) {
    const single = chosen(
      select(sellers, { stats, count: 1, random: seeded(seed) }),
    );
    assert.notEqual(single[0]?.nodeId, nodeId(4));
    const three = chosen(select(sellers, { stats, random: seeded(seed) }));
    for (const item of three)
      if (item.nodeId === nodeId(4)) assert.equal(item.exploration, true);
  }
});
void test('fresh sellers still fill slots when the buyer has too little history', () => {
  const sellers = [1, 2, 3, 4].map((index) => seller(index));
  const stats = new Map([[nodeId(1), history()]]);
  for (let seed = 1; seed <= 20; seed++)
    assert.equal(
      chosen(select(sellers, { stats, random: seeded(seed) })).length,
      3,
    );
});
void test('one owner contributes at most its highest-weight NodeId', () => {
  const { HIGH, MEDIUM } = REASONING_LEVELS;
  const sellers = [
    seller(1, { owner: 'Shared' }),
    seller(2, { owner: 'Shared', input: '50' }),
    seller(5, { owner: 'Shared', reasoning: [MEDIUM] }),
    seller(3),
  ];
  for (let seed = 1; seed <= 100; seed++) {
    const candidates = chosen(
      select(sellers, {
        request: request({ reasoning: HIGH, lowestReasoning: MEDIUM }),
        random: seeded(seed),
      }),
    );
    assert.deepEqual(
      new Set(candidates.map((item) => item.nodeId)),
      new Set([nodeId(1), nodeId(3)]),
    );
  }
});
