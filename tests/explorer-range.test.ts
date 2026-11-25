import assert from 'node:assert/strict';
import { test } from 'node:test';

import { delta } from '@gyblos/explorer/board-delta';
import { dailyPayouts, parseChainStats } from '@gyblos/explorer/chain-shape';
import { parseNetworkDay } from '@gyblos/explorer/collector-shape';
import { pricePerMtok } from '@gyblos/explorer/format';
import { overviewActivity } from '@gyblos/explorer/overview-activity';
import { overviewWindow } from '@gyblos/explorer/range';

void test('overview compares consecutive closed UTC days across a leap day', () => {
  const now = Date.parse('2024-03-01T18:00:00Z');
  for (const days of [7, 30] as const) {
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

void test('overview reconciles observed tokens and daily points without filling gaps', () => {
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
  assert.deepEqual(
    current.points.map((point) => point.requests),
    [100, null, null],
  );
  assert.equal(current.tokens, 120);
  assert.equal(current.requests, 100);
  assert.equal(current.complete, false);
  assert.equal(current.demand, null);
  assert.equal(current.free?.tokens, 100);
  assert.deepEqual(
    current.points.map((point) => point.tokens),
    [120, null, null],
  );
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

void test('model labels name a recognized lab and leave an unknown family unattributed', async () => {
  const { modelLab } = await import('@gyblos/explorer/model-family');
  assert.equal(modelLab('qwen3-0.6b'), 'Alibaba · Qwen');
  assert.equal(modelLab('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B'), 'DeepSeek');
  assert.equal(modelLab('acme/metadata-analyzer'), null);
  assert.equal(modelLab('custom-local-model'), null);
});

void test('zero payouts require a closed and indexed day', () => {
  const dates = ['2026-11-17', '2026-11-18'];
  const chain = {
    ...parseChainStats({
      days: dates.map((day) => ({ day, gyblosClaimed: null, program: null })),
      index: { backfillDone: true, updatedAt: Date.parse('2026-11-18') },
      aggregatedAt: null,
    }),
    error: null,
  };
  const stale = dailyPayouts(dates, chain);
  assert.equal(stale.complete, false);
  assert.deepEqual(stale.points, [0n, null]);
  assert.equal(stale.total, 0n);
  const fresh = dailyPayouts(dates, {
    ...chain,
    indexedAt: Date.parse('2026-11-19'),
  });
  assert.equal(fresh.complete, true);
  assert.deepEqual(fresh.points, [0n, 0n]);
});

void test('lifetime activity begins at the oldest observed day, skipping empty padding', async () => {
  const { firstOverviewDay } =
    await import('@gyblos/explorer/overview-activity');
  const blank = {
    day: '2026-01-01',
    free: null,
    paid: null,
    observed: null,
    demand: [],
  };
  assert.equal(firstOverviewDay([blank], []), null);
  assert.equal(
    firstOverviewDay(
      [
        blank,
        {
          ...blank,
          day: '2026-01-03',
          demand: [{ modelId: 'qwen', requests: 1 }],
        },
        {
          ...blank,
          day: '2026-01-02',
          observed: { routes: { direct: 1, relay: 0, unknown: 0 } },
        },
      ],
      [],
    ),
    '2026-01-02',
  );
});

void test('24h uses a complete UTC calendar day across midnight and preserves its range in links', async () => {
  const { displayRange, parseRange, rangeQuery, rangeEnd } =
    await import('@gyblos/explorer/range');
  const { canonicalPageHref, rangeOf, readQuery, sectionRangeHref } =
    await import('@gyblos/explorer/paging');
  const now = Date.parse('2024-03-01T00:00:01Z');
  assert.equal(parseRange('24h'), 1);
  assert.equal(parseRange('1'), 1);
  assert.equal(displayRange(1), 'last complete UTC day');
  assert.equal(canonicalPageHref({ range: '1' }), '/?range=24h');
  assert.equal(sectionRangeHref('', 'overview', 1), '/?overviewRange=24h');
  assert.equal(rangeOf(readQuery({ usageRange: '24h' }), 'usage'), 1);
  assert.equal(
    rangeQuery(1, rangeEnd(1, now)),
    '?from=2024-02-29&to=2024-02-29',
  );
  assert.equal(
    rangeQuery(1, rangeEnd(1, now, true), 1),
    '?from=2024-02-28&to=2024-02-28',
  );
});

void test('an explicit all-time chart survives switching the overview period', async () => {
  const { readQuery, queryHref } = await import('@gyblos/explorer/paging');
  const query = readQuery({ chartRange: 'all' });
  assert.equal(
    queryHref(query, { ranges: { overview: 7 } }),
    '/?overviewRange=7&chartRange=all',
  );
});

void test('published receipt changes compare observed samples from matching formulas', async () => {
  const { observedBaseline } =
    await import('@gyblos/explorer/overview-activity');
  assert.equal(observedBaseline(100, 2, 4, 4), 100);
  assert.equal(observedBaseline(100, 0, 4, 4), null);
  assert.equal(observedBaseline(100, 2, null, null), null);
  assert.equal(observedBaseline(100, 2, 4, 3), null);
  assert.equal(observedBaseline(0, 2, 4, 4), null);
});

void test('Network drill-down carries the chart period, metric and matching Stats tab through pagination', async () => {
  const { statsBreakdownHref, readQuery, queryHref, sectionRangeHref } =
    await import('@gyblos/explorer/paging');
  for (const metric of ['tokens', 'requests', 'paidOut'] as const) {
    const url = new URL(statsBreakdownHref(metric, 7), 'http://example.test');
    const query = readQuery(url.searchParams, url.pathname);
    assert.equal(query.days, 7);
    assert.equal(query.closed, true);
    assert.equal(query.metric, metric);
    assert.equal(query.tab, metric === 'paidOut' ? 'payments' : 'usage');
    const next = new URL(queryHref(query, { pages: { daily: 2 } }), url);
    assert.equal(next.searchParams.get('metric'), metric);
    const newRange = new URL(
      sectionRangeHref(next.search, 'usage', 30, '/stats'),
      url,
    );
    assert.equal(newRange.searchParams.get('range'), '30');
    assert.equal(newRange.searchParams.get('metric'), metric);
    assert.equal(newRange.searchParams.has('dailyPage'), false);
  }
  assert.equal(readQuery({}, '/stats').closed, true);
  assert.equal(readQuery({ chainDailyPage: '2' }, '/stats').tab, 'payments');
});
