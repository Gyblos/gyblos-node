import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';

import { BUYER_DISCOVERY } from '@gyblos/buyer/constants';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';

import {
  capacityNode,
  capacityOwner,
  discoveryCapacityFixture,
} from './support/discovery-capacity';

const WINDOW = BUYER_DISCOVERY.openWindowMs;
const SLOTS = BUYER_DISCOVERY.openSellers;
const fixedRank = (nodeId: string, window: number) =>
  createHash('sha256').update(`fixed:${window}:${nodeId}`).digest('hex');

async function liveFixture(
  t: TestContext,
  count: number,
  owner?: (n: number) => string,
) {
  const f = await discoveryCapacityFixture(t, count, owner);
  const far = f.now() + 1_000 * WINDOW;
  const rows = f.rows.map((row) => ({
    ...row,
    catalogExpiresAt: far,
    presenceExpiresAt: far,
  }));
  await f.write(rows);
  const candidates = rows.map(({ owner, nodeId }) => ({ owner, nodeId }));
  return { f, rows, candidates };
}

interface Candidate {
  owner: string;
  nodeId: string;
}
const admittedIds = (
  state: { eligible: (c: Candidate[], now: number) => Candidate[] },
  ids: Candidate[],
  now: number,
) => new Set(state.eligible(ids, now).map((seller) => seller.nodeId));

void test('every live seller gets a fair share of the slots across windows, not the lowest NodeIds', async (t) => {
  const { f, candidates } = await liveFixture(t, 200);
  f.policy.rank = fixedRank;
  const state = await f.open();
  const lowest = new Set(candidates.slice(0, SLOTS).map((c) => c.nodeId));
  const counts = new Map<string, number>();
  let lowestWins = 0;
  for (let window = 0; window < 50; window++) {
    const admitted = admittedIds(state, candidates, f.now() + window * WINDOW);
    assert.equal(admitted.size, SLOTS);
    if ([...lowest].every((nodeId) => admitted.has(nodeId))) lowestWins++;
    for (const nodeId of admitted)
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  assert.equal(lowestWins, 0);
  assert.equal(counts.size, candidates.length);
  for (const count of counts.values()) assert.ok(count >= 4 && count <= 32);
});

void test('one owner holds at most four slots, however low its NodeIds sort', async (t) => {
  const { f, candidates } = await liveFixture(t, 100, (n) =>
    capacityOwner(n <= SLOTS ? 0 : n),
  );
  const state = await f.open();
  const admitted = admittedIds(state, candidates, f.now());
  const captured = candidates.filter(
    (c) => c.owner === capacityOwner(0) && admitted.has(c.nodeId),
  );
  assert.equal(captured.length, BUYER_DISCOVERY.openPerOwner);
  assert.equal(admitted.size, 100 - SLOTS + BUYER_DISCOVERY.openPerOwner);
});

void test('a newcomer that outranks an admitted seller takes its slot and the loser keeps its row', async (t) => {
  const { f, candidates } = await liveFixture(t, SLOTS);
  f.policy.rank = fixedRank;
  const state = await f.open();
  let newcomer = 0;
  for (let n = 1000; n < 1020 && !newcomer; n++)
    if (await state.observe(f.seller(n))) newcomer = n;
  assert.ok(newcomer);
  const all = [
    ...candidates,
    { owner: capacityOwner(newcomer), nodeId: capacityNode(newcomer) },
  ];
  const admitted = admittedIds(state, all, f.now());
  assert.equal(admitted.size, SLOTS);
  assert.ok(admitted.has(capacityNode(newcomer)));
  const saved = (await f.saved()).rows as { nodeId: string }[];
  assert.equal(saved.length, SLOTS + 1);
  const loser = all.find((c) => !admitted.has(c.nodeId))!;
  assert.ok(saved.some((row) => row.nodeId === loser.nodeId));
});

void test('the default rank is secret per buyer process, stable within a window and redrawn across windows', async (t) => {
  const { f, candidates } = await liveFixture(t, 200);
  const policy = { configuredNodeIds: [], now: f.now };
  const a = await buyerDiscoveryState(f.home.environment, policy);
  const b = await buyerDiscoveryState(f.home.environment, policy);
  const now = f.now();
  const first = admittedIds(a, candidates, now);
  assert.deepEqual(admittedIds(a, candidates, now), first);
  assert.notDeepEqual(admittedIds(b, candidates, now), first);
  assert.notDeepEqual(admittedIds(a, candidates, now + WINDOW), first);
});
