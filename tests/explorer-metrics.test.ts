// Protects the explorer's pure metric logic: histograms are merged, never averaged; free and paid stay
// apart in every figure; collector answers (receipts and chain) are checked at the boundary; chain
// amounts stay exact and the effective fee is a share of the payouts; model variants are kept apart.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseChainStats, summarizeChain } from '@gyblos/explorer/chain-shape';
import {
  parseNetworkDay,
  type CollectorSnapshot,
} from '@gyblos/explorer/collector-shape';
import { mergedLatency, type Latency } from '@gyblos/explorer/latency';
import { completion, modelRows } from '@gyblos/explorer/model-table';
import { summarizeOffers } from '@gyblos/explorer/offers';
import { successRate, summarizeUsage } from '@gyblos/explorer/usage';

const BUCKETS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
function latency(...samples: number[]): Latency {
  const counts = Array<number>(BUCKETS.length + 1).fill(0);
  for (const sample of samples) {
    const index = BUCKETS.findIndex((edge) => sample < edge);
    counts[index === -1 ? BUCKETS.length : index]! += 1;
  }
  return {
    samples: samples.length,
    p50Ms: null,
    p95Ms: null,
    bucketsMs: BUCKETS,
    counts,
  };
}
function side(
  requests: number,
  completed: number,
  failed: number,
  tokens: number,
) {
  return {
    requests: {
      headline: requests,
      bilateral: requests,
      sellerOnly: 0,
      disputed: 0,
    },
    outcomes: { completed, failed, cancelled: 0 },
    successRate: completed / (completed + failed),
    tokens: { input: 0, output: tokens, reasoning: 0, reasoningUnknown: 0 },
    sellerLatency: { firstToken: latency(150), total: latency(900) },
    activeSellers: 1,
    modelsServed: 1,
    buyers: null,
    withheld: true,
  };
}

void test('histograms are merged bucket by bucket, past the last bound reads above, none reads null', () => {
  assert.equal(mergedLatency([latency(150), latency(3000, 3000)], 0.5), 5000);
  assert.equal(mergedLatency([latency(70_000)], 0.5), 'above');
  assert.equal(mergedLatency([undefined, null], 0.5), null);
});

void test('free and paid figures are never added up', () => {
  const snapshot: CollectorSnapshot = {
    aggregatedAt: 1,
    models: [],
    error: null,
    days: [
      {
        day: '2026-11-16',
        free: { ...side(10_000, 9_900, 100, 50_000), authorizedAtomic: null },
        paid: { ...side(50, 30, 20, 400), authorizedAtomic: '1000' },
        observed: null,
        demand: [{ modelId: 'wanted/model', requests: 3 }],
      },
    ],
  };
  const usage = summarizeUsage(snapshot);
  assert.deepEqual(
    [usage.free.requests, usage.free.successRate, usage.free.outputTokens],
    [10_000, 0.99, 50_000],
  );
  // Paid failures stay visible instead of disappearing into the free volume.
  assert.deepEqual(
    [usage.paid.requests, usage.paid.successRate, usage.paid.outputTokens],
    [50, 0.6, 400],
  );
  assert.equal(usage.authorized, 1000n);
  assert.equal(usage.unserved, 3);
});

void test('a collector day is checked at the boundary', () => {
  const day = parseNetworkDay({
    day: '2026-11-16',
    free: null,
    paid: null,
    observed: { routes: { direct: 1, relay: 2, unknown: 0 } },
    demand: [
      {
        modelId: 'wanted/model',
        unserved: 1,
        refusedBeforeSelection: 2,
        connectFailed: 3,
      },
    ],
  });
  assert.deepEqual(day.demand, [{ modelId: 'wanted/model', requests: 6 }]);
  assert.throws(
    () =>
      parseNetworkDay({
        day: '2026-11-16',
        free: null,
        paid: null,
        observed: null,
      }),
    {
      name: 'SourceShapeError',
    },
  );
  assert.throws(
    () =>
      parseNetworkDay({
        day: '2026-11-16',
        free: null,
        paid: { requests: {} },
        observed: null,
        demand: [],
      }),
    { name: 'SourceShapeError' },
  );
});

void test('chain stats are checked at the boundary, summed exactly, and the fee is a share of the payouts', () => {
  const usdc = (settled: string, fees: string, paidOut: string) => ({
    depositedAtomic: '10000',
    settledAtomic: settled,
    gyblosFeesAtomic: fees,
    programTreasuryAtomic: '0',
    refundedAtomic: '0',
    paidOutAtomic: paidOut,
  });
  const section = (
    settled: string,
    fees: string,
    paidOut: string,
    channels: number,
  ) => ({
    transactions: 3,
    channels,
    payers: 1,
    payees: 1,
    undecodable: 0,
    instructions: {
      open: 1,
      settle: 1,
      topUp: 0,
      settleAndSeal: 1,
      requestClose: 0,
      seal: 0,
      distribute: 1,
      reclaim: 0,
    },
    usdc: usdc(settled, fees, paidOut),
  });
  const snapshot = {
    ...parseChainStats({
      aggregatedAt: 5,
      index: { backfillDone: true, updatedAt: 4 },
      days: [
        {
          day: '2026-11-15',
          program: { transactions: 200, failed: 1 },
          gyblosClaimed: section('9007199254740993', '400', '9600', 2),
        },
        {
          day: '2026-11-16',
          program: { transactions: 300, failed: 0 },
          gyblosClaimed: null,
        },
        {
          day: '2026-11-17',
          program: null,
          gyblosClaimed: section('7', '0', '0', 1),
        },
      ],
    }),
    error: null,
  };
  const summary = summarizeChain(snapshot);
  // Exact beyond 2^53, never a float.
  assert.equal(summary.totals.settled, 9007199254741000n);
  assert.equal(summary.programTransactions, 500);
  // Distinct counts are per day: the largest daily value, never a sum.
  assert.equal(summary.totals.channels, 2);
  // 400 of 10000 paid out in all is 4%.
  assert.equal(summary.feeShare, 0.04);
  assert.deepEqual(
    summary.days.map((entry) => entry.day),
    ['2026-11-15', '2026-11-17'],
  );
  assert.throws(
    () =>
      parseChainStats({
        aggregatedAt: null,
        index: null,
        days: [
          {
            day: 'x',
            program: null,
            gyblosClaimed: { ...section('1.5', '0', '0', 1) },
          },
        ],
      }),
    { name: 'SourceShapeError' },
  );
});

void test('offers of the same model with different variants are summarized apart', () => {
  const offer = (variant: string | null) => ({
    modelId: 'm',
    variant,
    quantization: 'Q4',
    contextTokens: 1,
    pricing: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  });
  const summary = summarizeOffers({
    generatedAt: 0,
    network: null,
    error: null,
    sellers: [
      {
        nodeId: 'n',
        owner: 'o',
        uptime: null,
        models: [offer(null), offer('instruct')],
      },
    ],
  });
  assert.deepEqual(
    [...summary.models.values()].map((model) => model.variant),
    [null, 'instruct'],
  );
});

void test('the models table joins offers now with receipts, keeps both kinds of rows and counts cancellations apart', () => {
  const offers = summarizeOffers({
    generatedAt: 0,
    network: null,
    error: null,
    sellers: [
      {
        nodeId: 'n',
        owner: 'o',
        uptime: null,
        models: [
          {
            modelId: 'new',
            variant: null,
            quantization: null,
            contextTokens: 8,
            pricing: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
          },
          {
            modelId: 'served',
            variant: null,
            quantization: 'Q4',
            contextTokens: 8,
            pricing: { inputAtomicPerMtok: '5', outputAtomicPerMtok: '9' },
          },
        ],
      },
    ],
  });
  const withCancel = (completed: number, failed: number, cancelled: number) => {
    const base = side(completed + failed + cancelled, completed, failed, 0);
    return {
      ...base,
      outcomes: { completed, failed, cancelled },
      authorizedAtomic: null,
      sellers: 1,
    };
  };
  const rows = modelRows(offers.models, [
    {
      modelId: 'served',
      variant: null,
      quantization: 'Q4',
      free: null,
      paid: withCancel(18, 2, 3),
    },
    {
      modelId: 'gone',
      variant: null,
      quantization: null,
      free: withCancel(1, 0, 0),
      paid: null,
    },
    {
      modelId: 'empty',
      variant: null,
      quantization: null,
      free: withCancel(0, 0, 0),
      paid: null,
    },
  ]);
  assert.deepEqual(
    rows.map((row) => row.modelId),
    ['served', 'new', 'gone'],
  );
  const [served, fresh, gone] = rows;
  assert.equal(served?.now?.minOutput, 9n);
  assert.deepEqual(completion(served!.paid!), { done: 18, of: 20, ratio: 0.9 });
  assert.equal(served?.paid?.cancelled, 3);
  assert.equal(served?.paid?.firstToken, 200);
  assert.equal(fresh?.free, null);
  assert.equal(gone?.now, null);
});

void test('cancellations stay out of the success rate', () => {
  const day = (cancelled: number) => ({
    ...side(30, 18, 2, 0),
    outcomes: { completed: 18, failed: 2, cancelled },
    authorizedAtomic: null,
  });
  assert.equal(successRate([day(10)]), 0.9);
});
