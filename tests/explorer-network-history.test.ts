import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { DISCOVERY_URL } from '@gyblos/explorer/config';
import { getSellersOnlineHistory } from '@gyblos/explorer/network-history';
import {
  sellersOnlinePoints,
  sellersOnlineSummary,
} from '@gyblos/explorer/sellers-online';
import { DISCOVERY_READ_LIMITS } from '@gyblos/protocol/constants';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const finalDay = {
  day: '2026-11-24',
  state: 'final',
  averageOnline: 1.3993,
  peak: 2,
  nodeSlots: 403,
  coveredSlots: 288,
  expectedSlots: 288,
};
const pendingDay = {
  day: '2026-11-25',
  state: 'pending',
  averageOnline: null,
  peak: null,
  nodeSlots: null,
  coveredSlots: null,
  expectedSlots: 288,
};
const unwatchedDay = {
  ...finalDay,
  day: '2026-11-23',
  averageOnline: 1.1111,
  coveredSlots: 0,
};
const today = {
  day: '2026-11-26',
  state: 'partial',
  averageOnline: 2,
  peak: 2,
  nodeSlots: 450,
  coveredSlots: 223,
  expectedSlots: 225,
};
const body = (overrides: Record<string, unknown> = {}) => ({
  days: 90,
  slotMs: 300_000,
  history: [unwatchedDay, finalDay, pendingDay, today],
  generatedAt: 1,
  ...overrides,
});

function serve(answer: unknown, status = 200) {
  const urls: string[] = [];
  globalThis.fetch = (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(answer), { status }));
  };
  return urls;
}

async function parsed(history: unknown[]) {
  serve(body({ history }));
  return (await getSellersOnlineHistory()).days;
}

void test('reads the 90-day network history from the discovery index', async () => {
  const urls = serve(body());
  const history = await getSellersOnlineHistory();
  assert.deepEqual(urls, [`${DISCOVERY_URL}/network/history?days=90`]);
  assert.equal(history.error, false);
  assert.deepEqual(
    history.days.map((day) => [day.day, day.state, day.averageOnline]),
    [
      ['2026-11-23', 'final', 1.1111],
      ['2026-11-24', 'final', 1.3993],
      ['2026-11-25', 'pending', null],
      ['2026-11-26', 'partial', 2],
    ],
  );
});

void test('an unexpected answer leaves the section unavailable', async () => {
  const { coveredSlots: _covered, ...missing } = finalDay;
  for (const answer of [
    body({ days: 30 }),
    body({ history: {} }),
    body({ history: [{ ...finalDay, state: 'unknown' }] }),
    body({ history: [{ ...finalDay, averageOnline: '1' }] }),
    body({ history: [{ ...finalDay, day: 'yesterday' }] }),
    body({ history: [{ ...finalDay, averageOnline: null }] }),
    body({ history: [{ ...finalDay, peak: null }] }),
    body({ history: [missing] }),
    body({ history: [{ ...finalDay, peak: -1 }] }),
    body({ history: [{ ...finalDay, coveredSlots: 1.5 }] }),
    body({ history: [{ ...finalDay, expectedSlots: 0 }] }),
    body({ history: [{ ...pendingDay, peak: 1 }] }),
    body({ history: [finalDay, unwatchedDay] }),
    body({ history: [finalDay, finalDay] }),
    body({ history: [today, pendingDay] }),
    body({ history: Array(91).fill(finalDay) }),
    body({ pad: 'x'.repeat(DISCOVERY_READ_LIMITS.maxResponseBytes) }),
  ]) {
    serve(answer);
    assert.deepEqual(await getSellersOnlineHistory(), {
      days: [],
      error: true,
    });
  }
  serve(body(), 503);
  assert.equal((await getSellersOnlineHistory()).error, true);
});

void test('final days are bars, pending days are gaps and today is marked so far', async () => {
  const points = sellersOnlinePoints(await parsed(body().history));
  assert.deepEqual(
    points.map(({ day, tick, value, amount }) => [day, tick, value, amount]),
    [
      ['2026-11-23', '23', 1.1111, 1.1111],
      ['2026-11-24', '24', 1.3993, 1.3993],
      ['2026-11-25', '25', null, null],
      ['2026-11-26', '26', 2, 2],
    ],
  );
  assert.deepEqual(
    points.map((point) => point.detail),
    [
      'peak 2 · no index heartbeat',
      'peak 2 · 288 of 288 slots watched',
      'pending',
      'so far · peak 2 · 223 of 225 slots watched',
    ],
  );
});

void test('the headline averages the full days shown', async () => {
  const days = await parsed(body().history);
  assert.deepEqual(sellersOnlineSummary(days), {
    average: 1.255,
    fullDays: 2,
  });
  assert.deepEqual(sellersOnlineSummary(days.slice(2)), {
    average: null,
    fullDays: 0,
  });
});

void test('an empty past day the index did not watch is a gap, not a zero', async () => {
  const quiet = {
    ...finalDay,
    day: '2026-11-22',
    averageOnline: 0,
    peak: 0,
    nodeSlots: 0,
    coveredSlots: 0,
  };
  const watchedQuiet = { ...quiet, day: '2026-11-21', coveredSlots: 288 };
  const days = await parsed([watchedQuiet, quiet, finalDay]);
  assert.deepEqual(
    sellersOnlinePoints(days).map(({ value, detail }) => [value, detail]),
    [
      [0, 'peak 0 · 288 of 288 slots watched'],
      [null, 'no index heartbeat'],
      [1.3993, 'peak 2 · 288 of 288 slots watched'],
    ],
  );
  assert.deepEqual(sellersOnlineSummary(days), {
    average: 0.7,
    fullDays: 2,
  });
});

void test('today stays marked so far before its first heartbeat', async () => {
  const early = {
    ...today,
    averageOnline: 0,
    peak: 0,
    nodeSlots: 0,
    coveredSlots: 0,
    expectedSlots: 1,
  };
  const [point] = sellersOnlinePoints(await parsed([early]));
  assert.deepEqual(
    [point?.value, point?.detail],
    [0, 'so far · peak 0 · no index heartbeat'],
  );
});
