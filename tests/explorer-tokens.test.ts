import assert from 'node:assert/strict';
import test from 'node:test';

import type { NetworkSide } from '@gyblos/explorer/collector-shape';
import { summarizeUsage } from '@gyblos/explorer/usage';

const NO_LATENCY = {
  samples: 0,
  p50Ms: null,
  p95Ms: null,
  bucketsMs: [],
  counts: [0],
};

function side(input: number, output: number, paid: boolean): NetworkSide {
  return {
    requests: { headline: 1, bilateral: 1, sellerOnly: 0, disputed: 0 },
    outcomes: { completed: 1, failed: 0, cancelled: 0 },
    successRate: 1,
    tokens: { input, output, reasoning: 0, reasoningUnknown: 0 },
    sellerLatency: { firstToken: NO_LATENCY, total: NO_LATENCY },
    authorizedAtomic: paid ? '1' : null,
    activeSellers: 1,
    modelsServed: 1,
    buyers: null,
    withheld: true,
  };
}

const day = (
  date: string,
  free: NetworkSide | null,
  paid: NetworkSide | null,
) => ({
  day: date,
  coverage: null,
  free,
  paid,
  observed: null,
  demand: [],
});

void test('tokens processed add input and output, each side apart', () => {
  const usage = summarizeUsage({
    aggregatedAt: 1,
    models: [],
    buyerTotals: null,
    error: null,
    days: [
      day('2026-11-16', side(20_000, 50_000, false), side(300, 400, true)),
      day('2026-11-17', side(1, 2, false), null),
    ],
  });
  assert.equal(usage.free.tokens, 70_003);
  assert.equal(usage.paid.tokens, 700);
});
