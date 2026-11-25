import assert from 'node:assert/strict';
import test from 'node:test';

import { periodBars } from '@gyblos/explorer/period-bars';

const day = '2026-11-24';
const at = Date.parse(day);
const point = { day, tokens: 12, requests: 2, paidOut: '0.000003' } as const;
const samples = [{ at, tokens: 12, requests: 2, paidOut: 3n }];

void test('closed-day charts use measured half hours and withhold unreconciled totals', () => {
  const bars = periodBars([point], 1, samples);
  assert.equal(bars.length, 48);
  assert.equal(bars[0]?.tokens, 12);
  assert.equal(bars[1]?.requests, 0);
  assert.equal(bars[0]?.paidOut, '0.000003');
  assert.equal(periodBars([point], 1, [])[0]?.tokens, null);
});

void test('weekly charts divide each day into four six-hour blocks with two bars each', () => {
  const bars = periodBars([point], 7, samples);
  assert.equal(bars.length, 8);
  assert.equal(bars.filter((row) => row.blockStart).length, 4);
  assert.equal(bars.at(-1)?.tick, '21');
});

void test('calendar charts include all dates of leap February across a month boundary', () => {
  const bars = periodBars(
    [
      { ...point, day: '2024-02-29' },
      { ...point, day: '2024-03-01' },
    ],
    30,
    [],
  );
  assert.equal(bars.length, 60);
  assert.equal(bars[0]?.outside, true);
  assert.equal(bars[28]?.tokens, 12);
  assert.equal(bars[29]?.band, 'March 2024');
});
