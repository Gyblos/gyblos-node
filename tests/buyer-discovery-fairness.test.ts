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

void test('a seller in use keeps its slot across a window change until it goes unused for a window', async (t) => {
  const { f, rows, candidates } = await liveFixture(t, 200);
  f.policy.rank = fixedRank;
  const state = await f.open();
  const end = (Math.floor(f.now() / WINDOW) + 1) * WINDOW - 1;
  const [before, next, later] = [end, end + 1, end + 1 + WINDOW].map((now) =>
    admittedIds(state, candidates, now),
  );
  const row = rows.find(
    ({ nodeId }) =>
      before!.has(nodeId) && !next!.has(nodeId) && !later!.has(nodeId),
  )!;
  assert.equal(
    await state.permits(row.owner, row.nodeId, row.catalogDigest, end),
    true,
  );
  assert.ok(admittedIds(state, candidates, end + 1).has(row.nodeId));
  assert.ok(!admittedIds(state, candidates, end + 1 + WINDOW).has(row.nodeId));
});

void test('a stored seller outside the slots still records its newer presence', async (t) => {
  const { f, candidates } = await liveFixture(t, SLOTS + 1);
  const state = await f.open();
  const outside = f.seller(SLOTS + 1);
  assert.ok(
    !admittedIds(state, candidates, f.now()).has(outside.catalog.nodeId),
  );
  const highWater = (await f.saved()).rows.at(-1).highWater as number;
  await state.observe({
    ...outside,
    presence: { ...outside.presence!, sequence: highWater + 1 },
  });
  assert.equal((await f.saved()).rows.at(-1).highWater, highWater + 1);
});

void test('a fifth seller of one owner is not stored while the slots are open', async (t) => {
  const { f } = await liveFixture(t, BUYER_DISCOVERY.openPerOwner, () =>
    capacityOwner(0),
  );
  const state = await f.open();
  const fifth = f.seller(BUYER_DISCOVERY.openPerOwner + 1);
  assert.equal(
    await state.observe({
      ...fifth,
      catalog: { ...fifth.catalog, owner: capacityOwner(0) },
      presence: { ...fifth.presence!, owner: capacityOwner(0) },
    }),
    false,
  );
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.openPerOwner);
});

void test('a seller chosen by hand is permitted even when its owner already holds four slots', async (t) => {
  const { f, rows } = await liveFixture(
    t,
    BUYER_DISCOVERY.openPerOwner + 1,
    () => capacityOwner(0),
  );
  const state = await f.open();
  const chosen = rows.at(-1)!;
  const permits = () =>
    state.permits(chosen.owner, chosen.nodeId, chosen.catalogDigest, f.now());
  assert.equal(await permits(), false);
  state.use(chosen.nodeId);
  assert.equal(await permits(), true);
});

void test('a seller chosen by hand is stored and permitted on its first observation', async (t) => {
  const { f } = await liveFixture(t, BUYER_DISCOVERY.openPerOwner, () =>
    capacityOwner(0),
  );
  const state = await f.open();
  const fifth = f.seller(BUYER_DISCOVERY.openPerOwner + 1);
  const chosen = {
    ...fifth,
    catalog: { ...fifth.catalog, owner: capacityOwner(0) },
    presence: { ...fifth.presence!, owner: capacityOwner(0) },
  };
  state.use(chosen.catalog.nodeId);
  assert.equal(await state.observe(chosen), true);
  const row = (await f.saved()).rows.at(-1) as { catalogDigest: string };
  assert.equal(
    await state.permits(
      capacityOwner(0),
      chosen.catalog.nodeId,
      row.catalogDigest,
      f.now(),
    ),
    true,
  );
});
