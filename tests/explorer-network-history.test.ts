import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { DISCOVERY_URL } from '@gyblos/explorer/config';
import {
  getSellersOnlineHistory,
  sellersOnlinePoints,
  sellersOnlineSummary,
} from '@gyblos/explorer/network-history';

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
    return Promise.resolve(
      new Response(
        typeof answer === 'string' ? answer : JSON.stringify(answer),
        { status },
      ),
    );
  };
  return urls;
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
  for (const answer of [
    body({ days: 30 }),
    body({ history: [{ ...finalDay, state: 'unknown' }] }),
    body({ history: [{ ...finalDay, averageOnline: '1' }] }),
    body({ history: [{ ...finalDay, day: 'yesterday' }] }),
    'x'.repeat(1_048_577),
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
  serve(body());
  const { days } = await getSellersOnlineHistory();
  const points = sellersOnlinePoints(days);
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
  assert.deepEqual(
    sellersOnlinePoints(days, 2).map((point) => point.day),
    ['2026-11-25', '2026-11-26'],
  );
});

void test('the headline averages the full days shown', async () => {
  serve(body());
  const { days } = await getSellersOnlineHistory();
  assert.deepEqual(sellersOnlineSummary(days), {
    average: 1.2552,
    fullDays: 2,
  });
  assert.deepEqual(sellersOnlineSummary(days.slice(2)), {
    average: null,
    fullDays: 0,
  });
});

void test('an empty day the index did not watch is a gap, not a zero', async () => {
  const quiet = {
    ...finalDay,
    day: '2026-11-22',
    averageOnline: 0,
    peak: 0,
    nodeSlots: 0,
    coveredSlots: 0,
  };
  const watchedQuiet = { ...quiet, day: '2026-11-21', coveredSlots: 288 };
  serve(body({ history: [watchedQuiet, quiet, finalDay] }));
  const { days } = await getSellersOnlineHistory();
  assert.deepEqual(
    sellersOnlinePoints(days).map(({ value, detail }) => [value, detail]),
    [
      [0, 'peak 0 · 288 of 288 slots watched'],
      [null, 'no index heartbeat'],
      [1.3993, 'peak 2 · 288 of 288 slots watched'],
    ],
  );
  assert.deepEqual(sellersOnlineSummary(days), {
    average: 0.6997,
    fullDays: 2,
  });
});
