// Public seller uptime on the discovery index: each five-minute slot in which the index accepted a
// signed presence from a NodeId counts as online, GET /v1/uptime?node= reports the share of slots seen
// over a day, a week and a month (never before the NodeId was first seen), and rows older than a month
// are pruned. Both storage adapters; fake clock.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import {
  UPTIME,
  uptimePage,
  uptimeRecorder,
} from '@gyblos/discovery-index/uptime';

import {
  eachStorage,
  expectError,
  INDEX_ORIGIN,
  indexHarness,
  indexNode,
  memoryCache,
} from './support/discovery-index-fixture';

const { slotMs, dayMs } = UPTIME;

eachStorage(
  'uptime counts the slots in which the index accepted a presence',
  async ({ publish, call, clock }) => {
    const seller = indexNode();
    let sequence = 1;
    // A seller online now: a fresh catalog and a presence at the index's current time.
    const online = async () => {
      const catalog = seller.catalog(sequence++, { issuedAt: clock.now });
      assert.equal((await publish(catalog)).status, 201);
      const presence = await seller.presence(sequence++, catalog, {
        issuedAt: clock.now,
      });
      assert.equal((await publish(presence)).status, 201);
    };
    await expectError(
      await call(`/v1/uptime?node=${seller.nodeId}`),
      404,
      'NOT_FOUND',
    );
    const first = clock.now;
    // Online for four slots, a second presence inside the same slot, offline for four, then back.
    for (let slot = 0; slot < 4; slot++) {
      await online();
      clock.now += 1000;
      await online();
      clock.now += slotMs - 1000;
    }
    clock.now += 4 * slotMs;
    await online();
    const response = await call(`/v1/uptime?node=${seller.nodeId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.nodeId, seller.nodeId);
    assert.equal(body.firstSeenAt, first);
    assert.equal(body.lastSeenAt, clock.now);
    assert.equal(body.slotMs, slotMs);
    // Every window starts when the seller was first seen: 5 of 9 slots, whichever the window.
    const slots =
      Math.floor(clock.now / slotMs) - Math.floor(first / slotMs) + 1;
    assert.equal(slots, 9);
    assert.deepEqual(
      body.windows.map((window: { days: number }) => window.days),
      [1, 7, 30],
    );
    for (const window of body.windows) {
      assert.equal(window.seen, 5);
      assert.equal(window.slots, 9);
      assert.equal(window.ratio, 0.5556);
    }
    for (const query of [
      '',
      '?node=XYZ',
      `?node=${seller.nodeId.toUpperCase()}`,
      `?node=${seller.nodeId}&node=${seller.nodeId}`,
      `?node=${seller.nodeId}&x=1`,
    ])
      await expectError(await call(`/v1/uptime${query}`), 400, 'INVALID_QUERY');
  },
);

eachStorage(
  'a catalog or withdrawal alone is not uptime',
  async ({ publish, call }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    assert.equal((await publish(catalog)).status, 201);
    assert.equal(
      (await publish(await seller.withdrawal(2, catalog))).status,
      201,
    );
    await expectError(
      await call(`/v1/uptime?node=${seller.nodeId}`),
      404,
      'NOT_FOUND',
    );
  },
);

void test('windows are bounded by days, and a month-old row is pruned', async () => {
  const storage = createMemoryStorage();
  const node = 'a'.repeat(64);
  const now = 40 * dayMs;
  // Seen 20 days ago, then every slot of the last day.
  await storage.markSeen(node, now - 20 * dayMs);
  for (let at = now - dayMs + slotMs; at <= now; at += slotMs)
    await storage.markSeen(node, at);
  const body = JSON.parse((await uptimePage(storage, node, now))!);
  const [day, week, month] = body.windows;
  // Online for the whole last day: exactly a day of slots, all seen.
  assert.deepEqual([day.seen, day.slots, day.ratio], [288, 288, 1]);
  assert.deepEqual([week.seen, week.slots], [288, 7 * 288]);
  // The month window starts at the first sighting, 20 days ago.
  assert.deepEqual([month.seen, month.slots], [289, 20 * 288 + 1]);
  // Pruning keeps the first sighting: the old row is gone, the seller is not new.
  await storage.pruneUptime(now + 11 * dayMs);
  const later = JSON.parse(
    (await uptimePage(storage, node, now + 11 * dayMs))!,
  );
  assert.equal(later.firstSeenAt, now - 20 * dayMs);
  // Away for 40 days: nothing seen, no last sighting, but not forgotten.
  const back = now + 40 * dayMs;
  await storage.pruneUptime(back);
  const away = JSON.parse((await uptimePage(storage, node, back - slotMs))!);
  assert.equal(away.lastSeenAt, null);
  assert.deepEqual(
    away.windows.map((window: { seen: number }) => window.seen),
    [0, 0, 0],
  );
  // Back for two hours: the absence counts in every window.
  const hour = 3_600_000;
  for (let at = back; at < back + 2 * hour; at += slotMs)
    await storage.markSeen(node, at);
  const returned = JSON.parse(
    (await uptimePage(storage, node, back + 2 * hour - slotMs))!,
  );
  assert.deepEqual(
    returned.windows.map((window: { seen: number; slots: number }) => [
      window.seen,
      window.slots,
    ]),
    [
      [24, 288],
      [24, 7 * 288],
      [24, 30 * 288],
    ],
  );
  assert.equal(await uptimePage(storage, 'b'.repeat(64), back), null);
});

void test('equivalent spellings of one query share one cache entry', async () => {
  const { cache, puts } = memoryCache();
  const { publish, call, clock } = (await indexHarness('memory', { cache }))!;
  const seller = indexNode();
  const catalog = seller.catalog(1, { issuedAt: clock.now });
  assert.equal((await publish(catalog)).status, 201);
  const presence = await seller.presence(2, catalog, { issuedAt: clock.now });
  assert.equal((await publish(presence)).status, 201);
  for (const query of [
    `node=${seller.nodeId}`,
    `node=${seller.nodeId}&`,
    `%6Eode=${seller.nodeId}`,
  ])
    assert.equal((await call(`/v1/uptime?${query}`)).status, 200);
  assert.deepEqual(puts, [`${INDEX_ORIGIN}/v1/uptime?node=${seller.nodeId}`]);
});

void test('old uptime is pruned while sellers keep publishing, and a failing uptime table never blocks a publish', async () => {
  const storage = createMemoryStorage();
  const pruned: number[] = [];
  const failing = {
    ...storage,
    pruneUptime: async (now: number) => {
      pruned.push(now);
      throw new Error('no such table: discovery_uptime');
    },
    markSeen: async () => {
      throw new Error('no such table: discovery_uptime');
    },
  };
  // A new NodeId is still admitted and its presence accepted; only its uptime is lost.
  const { publish, call, clock } = (await indexHarness('memory', {
    storage: failing,
  }))!;
  const seller = indexNode();
  const catalog = seller.catalog(1, { issuedAt: clock.now });
  assert.equal((await publish(catalog)).status, 201);
  const presence = await seller.presence(2, catalog, { issuedAt: clock.now });
  assert.equal((await publish(presence)).status, 201);
  assert.equal(pruned.length, 1);
  await expectError(
    await call(`/v1/uptime?node=${seller.nodeId}`),
    404,
    'NOT_FOUND',
  );
  pruned.length = 0;
  // A recorder prunes again only after its interval, whoever publishes.
  const working = {
    ...storage,
    pruneUptime: async (now: number) => void pruned.push(now),
  };
  const again = uptimeRecorder(working);
  await again('b'.repeat(64), 0);
  await again('b'.repeat(64), UPTIME.pruneIntervalMs - 1);
  await again('b'.repeat(64), UPTIME.pruneIntervalMs);
  assert.deepEqual(pruned, [0, UPTIME.pruneIntervalMs]);
});
