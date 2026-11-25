import assert from 'node:assert/strict';
import test from 'node:test';

import { NETWORK_HISTORY } from '@gyblos/discovery-index/constants';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { UPTIME } from '@gyblos/discovery-index/uptime';
import { scheduledHeartbeat } from '@gyblos/discovery-index/worker';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  eachStorage,
  expectError,
  indexNode,
  T0,
} from './support/discovery-index-fixture';

const { slotMs, hourMs, dayMs } = UPTIME;
const DAY0 = (Math.floor(T0 / dayMs) + 1) * dayMs;
const YESTERDAY = DAY0 + dayMs;
const TODAY = DAY0 + 2 * dayMs;
const NOW = TODAY + 6 * hourMs + 1000;
const nodeA = 'a'.repeat(64);
const nodeB = 'b'.repeat(64);
const nodeC = 'c'.repeat(64);
const isoDay = (start: number) => new Date(start).toISOString().slice(0, 10);

interface HistoryDay {
  day: string;
  averageOnline: number;
  peak: number;
  nodeSlots: number;
  coveredSlots: number;
  expectedSlots: number;
  partial: boolean;
}

eachStorage(
  'the daily average counts accepted presences per slot and the heartbeat marks coverage',
  async ({ call, clock, storage }) => {
    clock.now = NOW;
    for (let slot = 0; slot < UPTIME.slotsPerHour; slot++)
      await storage.markSeen(nodeA, YESTERDAY + slot * slotMs + 1, 100);
    await storage.markSeen(nodeB, YESTERDAY + 5 * slotMs + 2, 100);
    await storage.markSeen(nodeB, YESTERDAY + 6 * slotMs + 2, 100);
    await storage.markSeen(nodeC, YESTERDAY + hourMs + 3, 100);
    await storage.markSeen(nodeC, YESTERDAY + hourMs + 11 * slotMs + 3, 100);
    for (let at = YESTERDAY + slotMs; at < TODAY; at += 2 * slotMs)
      await storage.markAlive(at);
    await storage.markSeen(nodeA, DAY0 + 7 * hourMs, 100);
    await storage.markAlive(NOW);

    const response = await call('/v1/network/history?days=7');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.days, 7);
    assert.equal(body.slotMs, slotMs);
    assert.equal(body.generatedAt, NOW);
    const history: HistoryDay[] = body.history;
    assert.deepEqual(
      history.map((day) => day.day),
      Array.from({ length: 7 }, (_, index) =>
        isoDay(TODAY - (6 - index) * dayMs),
      ),
    );
    const [before, yesterday, today] = history.slice(-3);
    assert.deepEqual(yesterday, {
      day: isoDay(YESTERDAY),
      averageOnline: 0.0556,
      peak: 2,
      nodeSlots: 16,
      coveredSlots: 288,
      expectedSlots: 288,
      partial: false,
    });
    assert.deepEqual(before, {
      day: isoDay(DAY0),
      averageOnline: 0.0035,
      peak: 1,
      nodeSlots: 1,
      coveredSlots: 0,
      expectedSlots: 288,
      partial: false,
    });
    assert.deepEqual(today, {
      day: isoDay(TODAY),
      averageOnline: 0,
      peak: 0,
      nodeSlots: 0,
      coveredSlots: 2,
      expectedSlots: 73,
      partial: true,
    });
    for (const day of history.slice(0, 4))
      assert.deepEqual([day.nodeSlots, day.coveredSlots, day.peak], [0, 0, 0]);
  },
);

eachStorage(
  'only accepted presences count; a catalog alone does not',
  async ({ call, clock, publish }) => {
    clock.now = NOW;
    const seller = indexNode();
    const catalog = seller.catalog(1, { issuedAt: clock.now });
    assert.equal((await publish(catalog)).status, 201);
    const empty = await (await call('/v1/network/history')).json();
    assert.equal(empty.days, NETWORK_HISTORY.defaultDays);
    assert.equal(empty.history.at(-1).nodeSlots, 0);
    const presence = await seller.presence(2, catalog, {
      issuedAt: clock.now,
    });
    assert.equal((await publish(presence)).status, 201);
    const seen = await (await call('/v1/network/history?days=30')).json();
    assert.equal(seen.history.length, 30);
    assert.equal(seen.history.at(-1).nodeSlots, 1);
    assert.equal(seen.history.at(-1).peak, 1);
  },
);

eachStorage('the days parameter is strict', async ({ call, clock }) => {
  clock.now = NOW;
  const ninety = await (await call('/v1/network/history?days=90')).json();
  assert.equal(ninety.history.length, 90);
  for (const query of [
    '?days=8',
    '?days=07',
    '?days=',
    '?days=7&days=7',
    '?days=7&node=x',
    '?other=1',
  ])
    await expectError(
      await call(`/v1/network/history${query}`),
      400,
      'INVALID_QUERY',
    );
});

eachStorage(
  'heartbeat rows are pruned with uptime retention',
  async ({ storage }) => {
    const old = NOW - (UPTIME.retentionDays + 2) * dayMs;
    await storage.markAlive(old);
    await storage.markAlive(NOW);
    await storage.pruneUptime(NOW);
    const hours = (await storage.aliveSlots(0)).map((row) => row.hour);
    assert.deepEqual(hours, [
      Math.floor(NOW / hourMs) - 1,
      Math.floor(NOW / hourMs),
    ]);
  },
);

void test('the scheduled heartbeat marks two slots in D1, skips without a database and logs one code on failure', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  const storage = createD1Storage(database);
  const at = TODAY + 2 * hourMs;
  await scheduledHeartbeat({ DISCOVERY_DB: database }, at);
  assert.deepEqual(await storage.aliveSlots(0), [
    { hour: Math.floor(at / hourMs) - 1, slots: 1 << 11 },
    { hour: Math.floor(at / hourMs), slots: 1 },
  ]);
  await scheduledHeartbeat({}, at);
  const warn = context.mock.method(console, 'warn', () => undefined);
  database.raw.exec('DROP TABLE discovery_index_heartbeat');
  await scheduledHeartbeat({ DISCOVERY_DB: database }, at);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [['DISCOVERY_HEARTBEAT_FAILED']],
  );
});
