// Protects the per-model observations (migrations/0007): each telemetry event counts on its receipt's
// side, model and day; seller first tokens, untimed completions, events without a headline receipt are
// left out; and a late event recomputes its receipt's day.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

import {
  DAY,
  DAY_START,
  HOUR,
  insertEnvelope,
  insertObservation,
  insertReceipt,
  NOW,
  SELLER_A,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';

// The fixtures' default receipt buyer.
const BUYER = 'c3'.repeat(32);

const rowsOf = (
  database: ReturnType<typeof createCollectorD1>,
  query: string,
) => database.rows(query).map((row) => ({ ...row }));
const histogram = (edges: readonly number[], samples: number[]) => {
  const counts = Array<number>(edges.length + 1).fill(0);
  for (const sample of samples) {
    const index = edges.findIndex((edge) => sample < edge);
    counts[index === -1 ? counts.length - 1 : index]! += 1;
  }
  return JSON.stringify(counts);
};
const buckets = (...samples: number[]) =>
  histogram(AGGREGATES.latencyBucketsMs, samples);

void test('per-model observations join each event to its receipt for the paid flag, model and day', async () => {
  const database = createCollectorD1();
  const at = DAY_START + 3 * HOUR;
  const request = (name: string) => name.padEnd(32, '0');
  insertReceipt(database, { requestId: request('a1'), variant: 'q4' });
  insertReceipt(database, { requestId: request('b2'), paid: true });
  insertReceipt(database, {
    requestId: request('c3'),
    status: 'disputed',
  });
  const buyer = insertEnvelope(database, 'buyer', at);
  const seller = insertEnvelope(database, 'seller', at);
  const event = (
    requestId: string,
    fields: Record<string, unknown> & { type: string },
  ) => ({
    at,
    requestId,
    sellerNodeId: SELLER_A,
    buyerNodeId: BUYER,
    ...fields,
  });
  insertObservation(
    database,
    buyer,
    event(request('a1'), {
      type: 'first_token',
      streaming: true,
      firstTokenMs: 1200,
    }),
  );
  insertObservation(
    database,
    buyer,
    event(request('b2'), {
      type: 'first_token',
      streaming: true,
      firstTokenMs: 300,
    }),
  );
  // 40 output tokens in 2 s of generation: 20 tokens per second, on the paid side.
  insertObservation(
    database,
    seller,
    event(request('b2'), {
      type: 'completed',
      usage: { outputTokens: 40 },
      generationMs: 2000,
    }),
  );
  // Not counted: a buyer first token of a non-streaming request (it is the total time), a seller's
  // first token, a completion without a generation time, an event without a
  // receipt, and one whose receipt is disputed.
  insertObservation(
    database,
    buyer,
    event(request('a1'), {
      type: 'first_token',
      streaming: false,
      firstTokenMs: 5,
    }),
  );
  insertObservation(
    database,
    seller,
    event(request('a1'), { type: 'first_token', firstTokenMs: 10 }),
  );
  insertObservation(
    database,
    seller,
    event(request('a1'), { type: 'completed', usage: { outputTokens: 40 } }),
  );
  insertObservation(
    database,
    buyer,
    event(request('ff'), {
      type: 'first_token',
      streaming: true,
      firstTokenMs: 50,
    }),
  );
  insertObservation(
    database,
    buyer,
    event(request('c3'), {
      type: 'first_token',
      streaming: true,
      firstTokenMs: 50,
    }),
  );

  await runAggregation(database, NOW);
  const speed = (...samples: number[]) =>
    histogram(AGGREGATES.tokensPerSecondBuckets, samples);
  assert.deepEqual(
    rowsOf(
      database,
      'SELECT day, model_id, variant, paid, buyer_first_token_hist, engine_tps_hist FROM collector_agg_model_observed_daily ORDER BY paid',
    ),
    [
      {
        day: DAY,
        model_id: 'synthetic/model',
        variant: 'q4',
        paid: 0,
        buyer_first_token_hist: buckets(1200),
        engine_tps_hist: speed(),
      },
      {
        day: DAY,
        model_id: 'synthetic/model',
        variant: '',
        paid: 1,
        buyer_first_token_hist: buckets(300),
        engine_tps_hist: speed(20),
      },
    ],
  );
});

void test('an observation arriving after its receipt recomputes the receipt day', async () => {
  const database = createCollectorD1();
  const requestId = 'd4'.padEnd(32, '0');
  insertReceipt(database, { requestId });
  await runAggregation(database, NOW);
  // The event falls on the next UTC day, yet belongs to its receipt's day.
  const late = DAY_START + 25 * HOUR;
  const buyer = insertEnvelope(database, 'buyer', late);
  insertObservation(
    database,
    buyer,
    {
      type: 'first_token',
      streaming: true,
      at: late,
      requestId,
      sellerNodeId: SELLER_A,
      buyerNodeId: BUYER,
      firstTokenMs: 700,
    },
    NOW + HOUR,
  );
  await runAggregation(database, NOW + 2 * HOUR);
  assert.deepEqual(
    rowsOf(
      database,
      'SELECT day, buyer_first_token_hist FROM collector_agg_model_observed_daily',
    ),
    [{ day: DAY, buyer_first_token_hist: buckets(700) }],
  );
});

void test('only the receipt buyer attaches first tokens, and a repeated event adds one sample', async () => {
  const database = createCollectorD1();
  const requestId = 'f6'.padEnd(32, '0');
  insertReceipt(database, { requestId });
  const at = DAY_START + 3 * HOUR;
  const own = insertEnvelope(database, 'buyer', at);
  const other = insertEnvelope(database, 'buyer', at);
  const event = (buyerNodeId: string, firstTokenMs: number, offset = 0) => ({
    type: 'first_token',
    streaming: true,
    at: at + offset,
    requestId,
    sellerNodeId: SELLER_A,
    buyerNodeId,
    firstTokenMs,
  });
  // The same event uploaded again with other times: still one sample, the lowest.
  insertObservation(database, own, event(BUYER, 900));
  insertObservation(database, own, event(BUYER, 600, 1));
  // Another buyer naming the same request and seller is not this receipt's buyer.
  insertObservation(database, other, event('99'.repeat(32), 50));
  await runAggregation(database, NOW);
  assert.deepEqual(
    rowsOf(
      database,
      'SELECT buyer_first_token_hist FROM collector_agg_model_observed_daily',
    ),
    [{ buyer_first_token_hist: buckets(600) }],
  );
});
