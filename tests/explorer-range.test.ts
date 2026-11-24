import assert from 'node:assert/strict';
import { test } from 'node:test';

import { delta } from '@gyblos/explorer/board-delta';
import { parseNetworkDay } from '@gyblos/explorer/collector-shape';
import { pricePerMtok } from '@gyblos/explorer/format';
import {
  groupWeeks,
  overviewActivity,
} from '@gyblos/explorer/overview-activity';
import { overviewWindow } from '@gyblos/explorer/range';

void test('overview compares consecutive closed UTC days across a leap day', () => {
  const now = Date.parse('2024-03-01T18:00:00Z');
  for (const days of [7, 30, 90] as const) {
    const current = overviewWindow(days, now);
    const previous = overviewWindow(days, now, 1);
    assert.equal(current.at(-1), '2024-02-29');
    assert.equal(current.length, days);
    assert.equal(previous.length, days);
    assert.equal(
      Date.parse(current[0]!) - Date.parse(previous.at(-1)!),
      86400000,
    );
  }
});

void test('overview reconciles observed tokens and weekly buckets without filling gaps', () => {
  const latency = {
    samples: 0,
    p50Ms: null,
    p95Ms: null,
    bucketsMs: [],
    counts: [],
  };
  const side = (requests: number, input: number, output: number) => ({
    requests: {
      headline: requests,
      bilateral: requests,
      sellerOnly: 0,
      disputed: 0,
    },
    tokens: { input, output, reasoning: 12, reasoningUnknown: 0 },
    outcomes: { completed: requests, failed: 0, cancelled: 0 },
    successRate: 1,
    sellerLatency: { firstToken: latency, total: latency },
    activeSellers: 1,
    modelsServed: 1,
    buyers: null,
    withheld: true,
    authorizedAtomic: null,
  });
  const free = side(75, 40, 60);
  const paid = side(25, 0, 20);
  const dates = ['2026-11-15', '2026-11-16', '2026-11-17'];
  const source = {
    version: 4,
    updated: Date.parse('2026-11-18'),
    days: [
      parseNetworkDay({
        day: dates[0],
        free,
        paid,
        observed: null,
        demand: [],
      }),
    ],
  };
  const current = overviewActivity(dates, source);
  assert.equal(current.tokens, 120);
  assert.equal(current.requests, 100);
  assert.equal(current.complete, false);
  assert.equal(current.demand, null);
  assert.equal(current.free?.tokens, 100);
  assert.deepEqual(groupWeeks(current.points), [
    { day: dates[0], end: dates[0], tokens: 120, missing: 0 },
    { day: dates[1], end: dates[2], tokens: null, missing: 2 },
  ]);
  assert.equal(overviewActivity(dates, null).requests, null);
});

void test('an aggregate timestamp alone cannot certify a complete observation window', () => {
  const dates = ['2026-11-16'];
  const source = {
    version: 4,
    updated: Date.parse('2026-11-18'),
    days: [
      parseNetworkDay({
        day: dates[0],
        free: null,
        paid: null,
        observed: null,
        demand: [
          {
            modelId: 'test',
            unserved: 20,
            refusedBeforeSelection: 0,
            connectFailed: 0,
          },
        ],
      }),
    ],
  };
  assert.equal(overviewActivity(dates, source).demandComplete, false);
});

void test('a malformed cached offer price stays unavailable', () => {
  for (const raw of ['', '  ', '1.4', '-2', '0x10', 'unavailable'])
    assert.equal(pricePerMtok(raw), '—');
  assert.equal(pricePerMtok('0'), 'Free');
});

void test('a fall from 100 to 80 unserved attempts is favorable', () => {
  assert.deepEqual(delta(80, 100, 'down'), {
    label: '-20%',
    direction: 'down',
    tone: 'good',
  });
});
