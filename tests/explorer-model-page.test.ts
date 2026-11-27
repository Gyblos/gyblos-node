import assert from 'node:assert/strict';
import test from 'node:test';

import { parseModel, type NetworkDay } from '@gyblos/explorer/collector-shape';
import {
  COVERAGE_STATES,
  DISPLAY,
  UNITS,
  type CoverageState,
} from '@gyblos/explorer/constants';
import {
  demandPoints,
  latencyBars,
  modelNow,
  priceDays,
} from '@gyblos/explorer/model-page';

const DAY = UNITS.msPerDay;
const START = Date.UTC(2026, 10, 20);
const offer = (input: string, output: string, contextTokens = 8192) => ({
  modelId: 'qwen3-0.6b',
  variant: null,
  quantization: 'Q4_K_M',
  contextTokens,
  pricing: { inputAtomicPerMtok: input, outputAtomicPerMtok: output },
});
const seller = (nodeId: string, weekUptime: number | null) => ({
  nodeId,
  owner: 'owner',
  uptime:
    weekUptime === null
      ? null
      : {
          firstSeenAt: 1,
          readAt: 1,
          windows: [{ days: DISPLAY.weekWindow, ratio: weekUptime }],
        },
  models: [],
});

void test('the now summary counts sellers, free and paid offers, lowest prices, context and uptime', () => {
  const now = modelNow([
    { seller: seller('a', 1), offer: offer('0', '0', 4096) },
    { seller: seller('b', 0.5), offer: offer('26000', '104000', 16384) },
    { seller: seller('c', null), offer: offer('52000', '90000', 32768) },
  ]);
  assert.deepEqual(now, {
    sellers: 3,
    free: 1,
    paid: 2,
    minInput: 26000n,
    minOutput: 90000n,
    context: 32768,
    weekUptime: 0.75,
  });
  assert.deepEqual(modelNow([]), {
    sellers: 0,
    free: 0,
    paid: 0,
    minInput: null,
    minOutput: null,
    context: 0,
    weekUptime: null,
  });
});

const networkDay = (
  day: string,
  demand: { modelId: string; requests: number }[],
  coverage: CoverageState | null = COVERAGE_STATES.FINAL,
): NetworkDay => ({
  day,
  coverage,
  free: null,
  paid: null,
  observed: null,
  demand,
});

void test('unserved demand per day is a zero only when the day is final and its list is not cut', () => {
  const full = Array.from({ length: DISPLAY.demandModelsPerDay }, (_, i) => ({
    modelId: `m${i}`,
    requests: 1,
  }));
  const points = demandPoints(
    [
      networkDay('2026-11-20', [{ modelId: 'qwen3-0.6b', requests: 7 }]),
      networkDay('2026-11-21', []),
      networkDay('2026-11-22', full),
      networkDay('2026-11-23', [], COVERAGE_STATES.PENDING),
      networkDay('2026-11-24', [], null),
      networkDay(
        '2026-11-25',
        [{ modelId: 'qwen3-0.6b', requests: 3 }],
        COVERAGE_STATES.PARTIAL,
      ),
    ],
    'qwen3-0.6b',
  );
  assert.deepEqual(
    points.map(({ day, value }) => [day, value]),
    [
      ['2026-11-20', 7],
      ['2026-11-21', 0],
      ['2026-11-22', null],
      ['2026-11-23', null],
      ['2026-11-24', null],
      ['2026-11-25', 3],
    ],
  );
  assert.equal(points[4]?.detail, 'not captured');
  assert.equal(points[5]?.detail, 'so far');
  assert.equal(points[2]?.detail, 'not among the day’s top 20');
  assert.equal(points[3]?.detail, 'pending');
});

void test('latency bars name each bucket and its share of samples', () => {
  const bars = latencyBars({
    samples: 4,
    p50Ms: 500,
    p95Ms: 2000,
    bucketsMs: [100, 500, 2000],
    counts: [1, 2, 0, 1],
  });
  assert.deepEqual(bars, [
    { label: '< 100 ms', count: 1, share: 0.25 },
    { label: '100–500 ms', count: 2, share: 0.5 },
    { label: '500 ms–2 s', count: 0, share: 0 },
    { label: '≥ 2 s', count: 1, share: 0.25 },
  ]);
  assert.deepEqual(
    latencyBars({
      samples: 2,
      p50Ms: 500,
      p95Ms: 2000,
      bucketsMs: [100, 500, 2000, 5000],
      counts: [0, 1, 0, 1, 0],
    }).map((bar) => bar.label),
    ['100–500 ms', '500 ms–2 s', '2–5 s'],
  );
  assert.deepEqual(
    latencyBars({
      samples: 3,
      p50Ms: null,
      p95Ms: null,
      bucketsMs: [500],
      counts: [0, 0],
    }),
    [],
  );
  assert.deepEqual(latencyBars(null), []);
  assert.deepEqual(
    latencyBars({
      samples: 0,
      p50Ms: null,
      p95Ms: null,
      bucketsMs: [100],
      counts: [0, 0],
    }),
    [],
  );
});

const series = (
  nodeId: string,
  points: [number, number, bigint, bigint][],
) => ({
  key: nodeId,
  nodeId,
  modelId: 'qwen3-0.6b',
  variant: null,
  quantization: 'Q4_K_M',
  contextTokens: 8192,
  points: points.map(([at, end, input, output]) => ({
    at,
    end,
    input,
    output,
  })),
});

void test('price days give each day the lowest, median and highest price across the sellers offering', () => {
  const days = priceDays(
    [
      series('a', [
        [START, START + DAY / 2, 10n, 40n],
        [START + DAY / 2, START + 3 * DAY, 12n, 48n],
      ]),
      series('b', [[START + DAY, START + 2 * DAY, 30n, 60n]]),
      series('c', [[START + DAY + 1, START + DAY + 2, 20n, 50n]]),
    ],
    START,
    START + 3 * DAY,
  );
  assert.deepEqual(
    days.map((day) => [day.day, day.sellers, day.input, day.output]),
    [
      [
        '2026-11-20',
        1,
        { min: 12n, median: 12n, max: 12n },
        { min: 48n, median: 48n, max: 48n },
      ],
      [
        '2026-11-21',
        3,
        { min: 12n, median: 20n, max: 30n },
        { min: 48n, median: 50n, max: 60n },
      ],
      [
        '2026-11-22',
        1,
        { min: 12n, median: 12n, max: 12n },
        { min: 48n, median: 48n, max: 48n },
      ],
    ],
  );
  const empty = priceDays([], START, START + DAY);
  assert.deepEqual(empty, [
    { day: '2026-11-20', sellers: 0, input: null, output: null },
  ]);
});

void test('price days count each seller once at its latest price and take the spread over paid offers', () => {
  const contexts = series('a', [[START, START + DAY / 2, 10n, 40n]]);
  const larger = {
    ...series('a', [[START + DAY / 2, START + DAY, 20n, 80n]]),
    key: 'a-larger',
    contextTokens: 16384,
  };
  const free = series('f', [[START, START + DAY, 0n, 0n]]);
  const paid = series('b', [[START, START + DAY, 30n, 60n]]);
  const [day] = priceDays([contexts, larger, free, paid], START, START + DAY);
  assert.deepEqual(day, {
    day: '2026-11-20',
    sellers: 3,
    input: { min: 20n, median: 25n, max: 30n },
    output: { min: 60n, median: 70n, max: 80n },
  });
  const switched = series('s', [
    [START, START + DAY / 2, 40n, 90n],
    [START + DAY / 2, START + DAY, 0n, 0n],
  ]);
  const [mixed] = priceDays([switched], START, START + DAY);
  assert.deepEqual(mixed, {
    day: '2026-11-20',
    sellers: 1,
    input: { min: 40n, median: 40n, max: 40n },
    output: { min: 90n, median: 90n, max: 90n },
  });
  const [onlyFree] = priceDays([free], START, START + DAY);
  assert.deepEqual([onlyFree?.sellers, onlyFree?.input], [1, null]);
});

void test('days before a truncated history begins are unknown, not empty', () => {
  const days = priceDays(
    [series('a', [[START + DAY, START + 2 * DAY, 10n, 40n]])],
    START,
    START + 2 * DAY,
    START + DAY,
  );
  assert.deepEqual(
    days.map((day) => [day.day, day.sellers]),
    [
      ['2026-11-20', null],
      ['2026-11-21', 1],
    ],
  );
});

void test('a model side keeps how many distinct sellers served it', () => {
  const latency = {
    samples: 0,
    p50Ms: null,
    p95Ms: null,
    bucketsMs: [],
    counts: [0],
  };
  const side = {
    requests: { headline: 3, bilateral: 1, sellerOnly: 2, disputed: 0 },
    outcomes: { completed: 3, failed: 0, cancelled: 0 },
    successRate: 1,
    tokens: { input: 10, output: 20, reasoning: 0, reasoningUnknown: 0 },
    sellerLatency: { firstToken: latency, total: latency },
    authorizedAtomic: null,
    sellers: 2,
    observed: null,
  };
  const stat = parseModel({
    modelId: 'qwen3-0.6b',
    variant: null,
    quantization: null,
    free: side,
    paid: null,
  });
  assert.equal(stat.free?.sellers, 2);
  const { sellers: _sellers, ...older } = side;
  assert.equal(
    parseModel({
      modelId: 'x',
      variant: null,
      quantization: null,
      free: older,
      paid: null,
    }).free?.sellers,
    null,
  );
});
