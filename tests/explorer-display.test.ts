// Protects the explorer's display choices: the date range accepts only its presets and maps to the
// collector's inclusive UTC days; a model's mark comes from its id's family name, never a guess; the
// daily series keep every day of the range, empty ones as zero; the index's network status is read
// with its exact states and the sellers not online keep the index's order.
import assert from 'node:assert/strict';
import test from 'node:test';

import { delta } from '@gyblos/explorer/board-delta';
import { dailySettled } from '@gyblos/explorer/chain-shape';
import { tokensPerSecond, usdcDecimal } from '@gyblos/explorer/format';
import { modelFamily } from '@gyblos/explorer/model-family';
import { notOnline, parseNetworkStatus } from '@gyblos/explorer/network-status';
import { parseRange, rangeQuery } from '@gyblos/explorer/range';
import { dailyRequests, usageMeta } from '@gyblos/explorer/usage';

void test('the range is a preset or the 30-day default', () => {
  assert.equal(parseRange('7'), 7);
  assert.equal(parseRange('90'), 90);
  for (const value of [undefined, '', '8', '365', ['7'], '7d', 7])
    assert.equal(parseRange(value), 30);
});

void test('a range maps to the collector days ending today, inclusive', () => {
  const now = Date.parse('2026-11-18T13:45:00.000Z');
  assert.equal(rangeQuery(7, now), '?from=2026-11-12&to=2026-11-18');
  assert.equal(rangeQuery(30, now), '?from=2026-10-20&to=2026-11-18');
  assert.equal(rangeQuery(90, now), '?from=2026-08-21&to=2026-11-18');
});

void test('the previous period is the span of the same length just before the range', () => {
  const now = Date.parse('2026-11-18T13:45:00.000Z');
  assert.equal(rangeQuery(7, now, 1), '?from=2026-11-05&to=2026-11-11');
  assert.equal(rangeQuery(30, now, 1), '?from=2026-09-20&to=2026-10-19');
});

void test('a change says its direction and whether it is good news', () => {
  assert.deepEqual(delta(110, 100), {
    label: '+10%',
    direction: 'up',
    tone: 'good',
  });
  assert.deepEqual(delta(95, 100), {
    label: '-5.0%',
    direction: 'down',
    tone: 'bad',
  });
  assert.deepEqual(delta(95, 100, 'down'), {
    label: '-5.0%',
    direction: 'down',
    tone: 'good',
  });
  assert.deepEqual(delta(12n, 4n, 'none'), {
    label: '+200%',
    direction: 'up',
    tone: 'neutral',
  });
  assert.deepEqual(delta(68, 0), {
    label: 'New',
    direction: 'up',
    tone: 'good',
  });
  assert.deepEqual(delta(0, 0), {
    label: '0%',
    direction: 'flat',
    tone: 'neutral',
  });
});

void test('a model mark comes from the family in its id', () => {
  const cases: [string, string | null][] = [
    ['qwen3-0.6b', 'qwen'],
    ['Qwen2.5-Coder-7B', 'qwen'],
    ['llama3.2:3b', 'meta'],
    ['mistral-small', 'mistral'],
    ['gemma3:4b', 'gemma'],
    ['deepseek-r1', 'deepseek'],
    ['phi4-mini', 'microsoft'],
    ['gpt-oss-20b', 'openai'],
    ['claude-sonnet', 'claude'],
    ['granite3.3', 'ibm'],
    ['alpha-model', null],
    ['', null],
  ];
  for (const [id, family] of cases) assert.equal(modelFamily(id), family, id);
});

void test('daily series keep empty days as zero', () => {
  const requests = dailyRequests([
    {
      day: '2026-11-17',
      free: null,
      paid: null,
      observed: null,
      demand: [],
      origins: [],
      failures: [],
    },
  ] as unknown as Parameters<typeof dailyRequests>[0]);
  assert.deepEqual(requests, [{ day: '2026-11-17', free: 0, paid: 0 }]);
  const settled = dailySettled({
    aggregatedAt: null,
    backfillDone: false,
    days: [{ day: '2026-11-17', program: null, gyblos: null }],
    error: null,
  });
  assert.deepEqual(settled, [{ day: '2026-11-17', settled: 0n, settles: 0 }]);
});

const NODE = (fill: string) => fill.repeat(64);
const STATUS = {
  counts: { total: 3, online: 1, offline: 1, unpublished: 1 },
  nodes: [
    {
      nodeId: NODE('a'),
      state: 'online',
      firstSeenAt: 1,
      lastSeenAt: 3,
      models: ['qwen3-0.6b'],
    },
    {
      nodeId: NODE('b'),
      state: 'offline',
      firstSeenAt: 1,
      lastSeenAt: 2,
      models: [],
    },
    {
      nodeId: NODE('c'),
      state: 'unpublished',
      firstSeenAt: null,
      lastSeenAt: null,
      models: [],
    },
  ],
  truncated: false,
  generatedAt: 4,
};

void test('the network status is read with its exact states', () => {
  const status = parseNetworkStatus(STATUS);
  assert.deepEqual(status.counts, STATUS.counts);
  assert.deepEqual(
    notOnline(status).map((node) => [node.nodeId, node.state]),
    [
      [NODE('b'), 'offline'],
      [NODE('c'), 'unpublished'],
    ],
  );
  assert.equal(status.nodes[2]?.lastSeenAt, null);
});

void test('an unknown state or a malformed status is refused', () => {
  const bad = (change: (copy: typeof STATUS) => unknown) => {
    const copy = structuredClone(STATUS);
    return () => parseNetworkStatus(change(copy));
  };
  assert.throws(
    bad((copy) => ({ ...copy, nodes: [{ ...copy.nodes[0], state: 'away' }] })),
  );
  assert.throws(
    bad((copy) => ({ ...copy, counts: { ...copy.counts, online: '1' } })),
  );
  assert.throws(bad((copy) => ({ ...copy, truncated: 'no' })));
  assert.throws(bad(() => null));
});

void test('an animated USDC amount is the exact decimal of its atomic units', () => {
  assert.equal(usdcDecimal(0n), '0');
  assert.equal(usdcDecimal(32n), '0.000032');
  assert.equal(usdcDecimal(1_500_000n), '1.5');
  assert.equal(usdcDecimal(123_456_789_012_345_678n), '123456789012.345678');
  assert.equal(usdcDecimal(-70n), '-0.00007');
});

void test('engine speed reads as the lower bound of its bucket, the first bucket as below it, none as no data', () => {
  assert.equal(tokensPerSecond(20), '≥ 20 tok/s');
  assert.equal(tokensPerSecond(1000), '≥ 1,000 tok/s');
  assert.equal(tokensPerSecond(0), '< 1 tok/s');
  assert.equal(tokensPerSecond(null), '—');
});

void test('the Usage note names the comparison only when the earlier span was read', () => {
  const at = Date.UTC(2026, 10, 19, 20, 10);
  assert.equal(
    usageMeta(30, at, true),
    'vs previous 30 days · updated 2026-11-19 20:10 UTC',
  );
  assert.equal(usageMeta(30, at, false), 'updated 2026-11-19 20:10 UTC');
  assert.equal(usageMeta(30, null, true), 'no data yet');
});
