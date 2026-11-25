import assert from 'node:assert/strict';
import test from 'node:test';

import { NETWORK_HISTORY } from '@gyblos/discovery-index/constants';
import { rollupNetworkDays } from '@gyblos/discovery-index/network-history';
import type { DiscoveryStorage } from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { UPTIME } from '@gyblos/discovery-index/uptime';
import { scheduledNetwork } from '@gyblos/discovery-index/worker';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  eachStorage,
  expectError,
  indexNode,
  T0,
} from './support/discovery-index-fixture';

const { slotMs, hourMs, dayMs } = UPTIME;
const TODAY = (Math.floor(T0 / dayMs) + 100) * dayMs;
const YESTERDAY = TODAY - dayMs;
const DAY0 = TODAY - 2 * dayMs;
const WINDOW_START = TODAY - 6 * dayMs;
const BEFORE_WINDOW = TODAY - 7 * dayMs;
const NOW = TODAY + 6 * hourMs + 1000;
const nodeA = 'a'.repeat(64);
const nodeB = 'b'.repeat(64);
const nodeC = 'c'.repeat(64);
const isoDay = (start: number) => new Date(start).toISOString().slice(0, 10);
const dayNumber = (start: number) => Math.floor(start / dayMs);

interface HistoryDay {
  day: string;
  state: string;
  averageOnline: number | null;
  peak: number | null;
  nodeSlots: number | null;
  coveredSlots: number | null;
  expectedSlots: number;
}

async function rollAll(storage: DiscoveryStorage, now: number) {
  const runs: number[] = [];
  for (let run = await rollupNetworkDays(storage, now); run;) {
    runs.push(run);
    run = await rollupNetworkDays(storage, now);
  }
  return runs;
}

async function seed(storage: DiscoveryStorage) {
  for (let slot = 0; slot < UPTIME.slotsPerHour; slot++)
    await storage.markSeen(nodeA, YESTERDAY + slot * slotMs + 1, 100);
  await storage.markSeen(nodeB, YESTERDAY + 5 * slotMs + 2, 100);
  await storage.markSeen(nodeB, YESTERDAY + 6 * slotMs + 2, 100);
  await storage.markSeen(nodeC, YESTERDAY + hourMs + 3, 100);
  await storage.markSeen(nodeC, YESTERDAY + hourMs + 11 * slotMs + 3, 100);
  for (let at = YESTERDAY + slotMs; at < TODAY; at += 2 * slotMs)
    await storage.markAlive(at);
  await storage.markSeen(nodeA, DAY0 + 7 * hourMs, 100);
  await storage.markSeen(nodeB, WINDOW_START + 3 * hourMs, 100);
  await storage.markAlive(WINDOW_START + 3 * hourMs + slotMs);
  await storage.markSeen(nodeC, BEFORE_WINDOW + 3 * hourMs, 100);
  await storage.markAlive(BEFORE_WINDOW + 3 * hourMs + slotMs);
  await storage.markAlive(NOW);
}

const final = (
  start: number,
  nodeSlots: number,
  peak: number,
  coveredSlots: number,
  averageOnline: number,
) => ({
  day: isoDay(start),
  state: 'final',
  averageOnline,
  peak,
  nodeSlots,
  coveredSlots,
  expectedSlots: 288,
});

eachStorage(
  'past days come from the daily rollup and today is counted live',
  async ({ call, clock, storage }) => {
    clock.now = NOW;
    await seed(storage);
    const before = await (await call('/v1/network/history?days=7')).json();
    const pending: HistoryDay[] = before.history.slice(0, 6);
    assert.deepEqual(
      pending.map((day) => [day.state, day.nodeSlots, day.averageOnline]),
      Array(6).fill(['pending', null, null]),
    );
    const runs = await rollAll(storage, NOW);
    assert.equal(runs[0], NETWORK_HISTORY.rollupDaysPerRun);
    assert.equal(
      runs.reduce((total, run) => total + run, 0),
      NETWORK_HISTORY.maxDays - 1,
    );
    clock.now += 60_000;
    const response = await call('/v1/network/history?days=7');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.days, 7);
    assert.equal(body.slotMs, slotMs);
    const history: HistoryDay[] = body.history;
    assert.deepEqual(
      history.map((day) => day.day),
      Array.from({ length: 7 }, (_, index) =>
        isoDay(TODAY - (6 - index) * dayMs),
      ),
    );
    assert.deepEqual(history[0], final(WINDOW_START, 1, 1, 2, 0.0035));
    for (const day of history.slice(1, 4))
      assert.deepEqual(
        [day.state, day.nodeSlots, day.coveredSlots, day.peak],
        ['final', 0, 0, 0],
      );
    assert.deepEqual(history[4], final(DAY0, 1, 1, 0, 0.0035));
    assert.deepEqual(history[5], final(YESTERDAY, 16, 2, 288, 0.0556));
    assert.deepEqual(history[6], {
      day: isoDay(TODAY),
      state: 'partial',
      averageOnline: 0,
      peak: 0,
      nodeSlots: 0,
      coveredSlots: 2,
      expectedSlots: 73,
    });
    const ninety = await (await call('/v1/network/history?days=90')).json();
    assert.equal(ninety.history.length, 90);
    assert.deepEqual(
      ninety.history.find(
        (day: HistoryDay) => day.day === isoDay(BEFORE_WINDOW),
      ),
      final(BEFORE_WINDOW, 1, 1, 2, 0.0035),
    );
    const startHour = WINDOW_START / hourMs;
    assert.deepEqual(
      (await storage.onlineSlots(startHour, startHour + 24)).map(
        (row) => row.hour,
      ),
      [startHour + 3],
    );
  },
);

eachStorage(
  'a day is rolled up only after the run that vouches for its last slot',
  async ({ storage }) => {
    await rollAll(storage, TODAY + slotMs);
    const days = async () =>
      (await storage.networkDays(dayNumber(YESTERDAY) - 1)).map(
        (row) => row.day,
      );
    assert.deepEqual(await days(), [dayNumber(YESTERDAY) - 1]);
    await rollAll(storage, TODAY + 2 * slotMs);
    assert.deepEqual(await days(), [
      dayNumber(YESTERDAY) - 1,
      dayNumber(YESTERDAY),
    ]);
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
  'heartbeat and rollup rows are pruned with uptime retention',
  async ({ storage }) => {
    const old = NOW - (UPTIME.retentionDays + 2) * dayMs;
    await storage.markAlive(old);
    await storage.markAlive(NOW);
    const row = { nodeSlots: 1, peak: 1, coveredSlots: 1 };
    await storage.saveNetworkDay({ day: dayNumber(old), ...row });
    await storage.saveNetworkDay({ day: dayNumber(YESTERDAY), ...row });
    await storage.pruneUptime(NOW);
    const hour = Math.floor(NOW / hourMs);
    assert.deepEqual(
      (await storage.aliveSlots(0, hour + 1)).map((alive) => alive.hour),
      [hour - 1, hour],
    );
    assert.deepEqual(
      (await storage.networkDays(0)).map((day) => day.day),
      [dayNumber(YESTERDAY)],
    );
  },
);

void test('the scheduled run marks two slots, rolls up days and logs one code per failure', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  const storage = createD1Storage(database);
  const at = TODAY + 2 * hourMs;
  await scheduledNetwork({ DISCOVERY_DB: database }, at);
  const hour = Math.floor(at / hourMs);
  assert.deepEqual(await storage.aliveSlots(0, hour + 1), [
    { hour: hour - 1, slots: 1 << 11 },
    { hour, slots: 1 },
  ]);
  assert.equal(
    (await storage.networkDays(0)).length,
    NETWORK_HISTORY.rollupDaysPerRun,
  );
  await scheduledNetwork({}, at);
  const warn = context.mock.method(console, 'warn', () => undefined);
  database.raw.exec('DROP TABLE discovery_index_heartbeat');
  await scheduledNetwork({ DISCOVERY_DB: database }, at);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [['DISCOVERY_HEARTBEAT_FAILED'], ['DISCOVERY_NETWORK_ROLLUP_FAILED']],
  );
});

void test('uptime pruning still runs when the heartbeat table is missing', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  const storage = createD1Storage(database);
  await storage.markSeen(nodeA, NOW - (UPTIME.retentionDays + 2) * dayMs, 100);
  database.raw.exec('DROP TABLE discovery_index_heartbeat');
  await assert.rejects(storage.pruneUptime(NOW));
  assert.deepEqual(await storage.seen(nodeA, 0), []);
});
