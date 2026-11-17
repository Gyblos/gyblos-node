// Protects the explorer's pure metric logic: histograms are merged, never averaged; free and paid stay
// apart in every figure; collector answers are checked at the boundary; the effective fee is a share of
// the gross charge; a Solana channel transaction reads as a settlement; model variants are kept apart.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseNetworkDay,
  type CollectorSnapshot,
} from '@gyblos/explorer/collector-shape';
import { mergedLatency, type Latency } from '@gyblos/explorer/latency';
import { summarizeOffers } from '@gyblos/explorer/offers';
import { ratioText, summarizePayments } from '@gyblos/explorer/payments';
import { classify, type Settlement } from '@gyblos/explorer/settlement';
import { summarizeUsage } from '@gyblos/explorer/usage';

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

const CHANNEL = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';
const GYBLOS = '4Ui1dfvqbFx9CtjXNcKajHdr7aKT1nbYRiYjB1s7umNy';
function tx(instructions: unknown[], err: unknown = null) {
  const balance = (owner: string, amount: string) => ({
    accountIndex: 0,
    mint: 'Mint',
    owner,
    uiTokenAmount: { amount, decimals: 6 },
  });
  return {
    slot: 7,
    blockTime: 1_794_800_000,
    meta: {
      err,
      preTokenBalances: [
        balance('Payer', '10000'),
        balance('Seller', '0'),
        balance(GYBLOS, '0'),
      ],
      postTokenBalances: [
        balance('Payer', '0'),
        balance('Seller', '9600'),
        balance(GYBLOS, '400'),
      ],
    },
    transaction: { signatures: ['Sig'], message: { instructions } },
  };
}

void test('a channel transaction reads as a settlement and the fee is a share of the gross charge', () => {
  const settlement = classify(
    tx([
      { programId: CHANNEL, accounts: ['Channel', 'Payer', 'Payee', 'Vault'] },
    ]),
  );
  assert.ok(settlement);
  assert.deepEqual(
    [
      settlement.kind,
      settlement.payer,
      settlement.seller,
      settlement.sellerAtomic,
      settlement.feeAtomic,
    ],
    ['settlement', 'Payer', 'Seller', 9600n, 400n],
  );
  assert.equal(classify(tx([{ programId: 'Other', accounts: [] }])), null);
  assert.equal(
    classify(
      tx([{ programId: CHANNEL, accounts: ['a', 'b', 'c', 'd'] }], 'failed'),
    ),
    null,
  );
  assert.throws(() => classify({ meta: {}, transaction: {} }), {
    name: 'SourceShapeError',
  });

  const payments = summarizePayments({
    fetchedAt: 0,
    pending: 0,
    error: null,
    settlements: [settlement as Settlement],
  });
  // 400 of a 10000 gross charge is 4%, not 400 / 9600.
  assert.equal(ratioText(payments.fees, payments.gross), '4.0%');
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
  assert.deepEqual([...summary.models.keys()], ['m Q4', 'm instruct Q4']);
});
