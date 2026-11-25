// Protects the public stats API (#351): a signed upload reaches the aggregates and the network answer,
// free and paid stay apart, per-seller buyers are withheld below the minimum, bad queries are refused,
// answers are cacheable only on success, and each endpoint is one fixed batch of reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import {
  AGGREGATES,
  COLLECTOR_ERRORS,
  COLLECTOR_LIMITERS,
} from '@gyblos/metrics-collector/constants';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { fakeLimiter, signUpload } from './support/metrics-collector';
import {
  DAY,
  insertEnvelope,
  insertObservation,
  insertReceipt,
  NOW,
  SELLER_A,
  SELLER_B,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';
import {
  buyerUpload,
  freePair,
  sellerUpload,
  T0,
} from './support/receipt-upload';

// The fixtures' default receipt buyer.
const BUYER = 'c3'.repeat(32);

const ORIGIN = 'https://collector.test';
// The parts of a stats answer these tests read; the API shape is asserted field by field.
interface Side {
  requests: Record<string, number>;
  outcomes: Record<string, number>;
  successRate: number | null;
  backedByPayment?: false;
  authorizedAtomic?: string;
  buyers: number | null;
  withheld?: boolean;
  sellers?: number;
  observed?: {
    buyerFirstToken: { samples: number; p50Ms: number | null };
    engineSpeed: {
      samples: number;
      p50MinTokensPerSecond: number | null;
      bucketsTokensPerSecond: number[];
    };
  } | null;
}
interface Answer {
  error?: string;
  from?: string;
  range?: string;
  historyAvailable?: boolean;
  to?: string;
  formulaVersion?: number | null;
  aggregatedAt?: number | null;
  days: {
    day: string;
    free: Side;
    paid: Side | null;
    demand: { modelId: string }[];
  }[];
  models: { modelId: string; variant: string | null; free: Side; paid: Side }[];
}

function collector(
  database: ReturnType<typeof createCollectorD1>,
  now: number,
  withStats = true,
  limiters = {
    [COLLECTOR_LIMITERS.IP]: fakeLimiter(),
    [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
    [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
    [COLLECTOR_LIMITERS.READ]: fakeLimiter(),
  },
) {
  return createMetricsCollector({
    storage: createD1Storage(database),
    stats: withStats ? statsReader(database) : undefined,
    limiters,
    now: () => now,
  });
}
async function get(app: ReturnType<typeof collector>, path: string) {
  const response = await app.request(`${ORIGIN}${path}`);
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: (await response.json()) as Answer,
  };
}

void test('a signed receipt from both sides reaches the public network totals', async () => {
  const database = createCollectorD1();
  const app = collector(database, T0);
  const { seller, buyer, receipt } = await freePair();
  for (const [upload, signer] of [
    [sellerUpload(seller.nodeId, receipt), seller],
    [{ ...buyerUpload(buyer.nodeId, receipt), nonce: 'cd'.repeat(16) }, buyer],
  ] as const) {
    const response = await app.request(`${ORIGIN}/v1/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await signUpload(upload, signer.sign)),
    });
    assert.equal(response.status, 200);
  }
  const day = new Date(receipt.seller.record.timing.receivedAt)
    .toISOString()
    .split('T')[0]!;
  await runAggregation(database, T0);

  const answer = await get(app, `/v1/stats/network?from=${day}&to=${day}`);
  assert.equal(answer.status, 200);
  assert.equal(answer.cache, 'public, max-age=300');
  assert.equal(answer.body.aggregatedAt, T0);
  const [only] = answer.body.days;
  assert.equal(only!.day, day);
  assert.equal(only!.paid, null);
  assert.deepEqual(only!.free.requests, {
    headline: 1,
    bilateral: 1,
    sellerOnly: 0,
    disputed: 0,
  });
  assert.equal(only!.free.backedByPayment, false);
  assert.equal(only!.free.successRate, 1);
  // One buyer: below the public minimum, so the count is withheld at network level too.
  assert.deepEqual([only!.free.buyers, only!.free.withheld], [null, true]);
});

void test('models keep free and paid apart; sellers withhold buyers below the minimum', async () => {
  const database = createCollectorD1();
  for (let index = 0; index < AGGREGATES.minPublicBuyers; index++)
    insertReceipt(database, { buyer: index.toString(16).padStart(64, '0') });
  insertReceipt(database, { seller: SELLER_B });
  insertReceipt(database, { paid: true, payer: 'Wallet', amountAtomic: '7' });
  await runAggregation(database, NOW);
  const app = collector(database, NOW);

  const models = await get(app, `/v1/stats/models?from=${DAY}&to=${DAY}`);
  const [model] = models.body.models;
  assert.equal(model!.variant, null);
  assert.equal(model!.free.outcomes.completed, AGGREGATES.minPublicBuyers + 1);
  assert.equal(model!.free.sellers, 2);
  assert.equal(model!.paid.authorizedAtomic, '7');
  // No observation joined to a receipt: no data, never zero.
  assert.equal(model!.free.observed, null);

  const shown = await get(
    app,
    `/v1/stats/sellers/${SELLER_A}?from=${DAY}&to=${DAY}`,
  );
  assert.deepEqual(
    [shown.body.days[0]!.free.buyers, shown.body.days[0]!.free.withheld],
    [AGGREGATES.minPublicBuyers, false],
  );
  // One paid buyer: withheld.
  assert.deepEqual(
    [shown.body.days[0]!.paid?.buyers, shown.body.days[0]!.paid?.withheld],
    [null, true],
  );
  const hidden = await get(
    app,
    `/v1/stats/sellers/${SELLER_B}?from=${DAY}&to=${DAY}`,
  );
  assert.equal(hidden.body.days[0]!.free.buyers, null);
});

void test('bad queries are refused with a static code and nothing cacheable', async () => {
  const database = createCollectorD1();
  const app = collector(database, NOW);
  for (const path of [
    `/v1/stats/network?from=${DAY}&to=2026-11-01`,
    '/v1/stats/network?from=2026-01-01&to=2026-11-16',
    '/v1/stats/network?to=2026-02-30',
    '/v1/stats/network?from=yesterday',
    `/v1/stats/sellers/${'AB'.repeat(32)}`,
    '/v1/stats/sellers/abc',
  ]) {
    const answer = await get(app, path);
    assert.equal(answer.status, 400, path);
    assert.deepEqual(answer.body, { error: COLLECTOR_ERRORS.INVALID_QUERY });
    assert.equal(answer.cache, 'no-store');
  }
  const missing = await get(
    collector(database, NOW, false),
    '/v1/stats/network',
  );
  assert.equal(missing.status, 503);
});

void test('the default range is the last days up to today, each endpoint one batch of reads', async () => {
  const database = createCollectorD1();
  const app = collector(database, NOW);
  database.log.length = 0;
  const answer = await get(app, '/v1/stats/network');
  assert.equal(answer.body.to, '2026-11-17');
  assert.equal(answer.body.days.length, AGGREGATES.defaultRangeDays);
  assert.equal(answer.body.aggregatedAt, null);
  const batches = new Set(database.log.map((entry) => entry.batch));
  assert.equal(batches.size, 1);
  assert.equal(database.log.length, 11);

  database.log.length = 0;
  await get(app, `/v1/stats/sellers/${SELLER_A}`);
  assert.equal(database.log.length, 3);
  database.log.length = 0;
  await get(app, '/v1/stats/models');
  assert.equal(database.log.length, 2);
  assert.equal(new Set(database.log.map((entry) => entry.batch)).size, 1);
});

void test('the network withholds unique buyers below the minimum and shows them at it', async () => {
  const database = createCollectorD1();
  for (let index = 0; index < AGGREGATES.minPublicBuyers; index++)
    insertReceipt(database, { buyer: index.toString(16).padStart(64, '0') });
  insertReceipt(database, { paid: true, payer: 'Wallet' });
  await runAggregation(database, NOW);
  const { body } = await get(
    collector(database, NOW),
    `/v1/stats/network?from=${DAY}&to=${DAY}`,
  );
  const [day] = body.days;
  assert.deepEqual(
    [day!.free.buyers, day!.free.withheld],
    [AGGREGATES.minPublicBuyers, false],
  );
  assert.deepEqual([day!.paid?.buyers, day!.paid?.withheld], [null, true]);
  assert.equal(body.formulaVersion, AGGREGATES.formulaVersion);
});

void test('a range of maxRangeDays days is accepted and one more day is refused', async () => {
  const app = collector(createCollectorD1(), NOW);
  const from = (days: number) =>
    new Date(Date.parse(`${DAY}T00:00:00.000Z`) - (days - 1) * AGGREGATES.dayMs)
      .toISOString()
      .split('T')[0]!;
  const ok = await get(
    app,
    `/v1/stats/network?from=${from(AGGREGATES.maxRangeDays)}&to=${DAY}`,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.days.length, AGGREGATES.maxRangeDays);
  const tooLong = await get(
    app,
    `/v1/stats/network?from=${from(AGGREGATES.maxRangeDays + 1)}&to=${DAY}`,
  );
  assert.equal(tooLong.status, 400);
});

void test('answers cap models and per-day demand, largest first', async () => {
  const database = createCollectorD1();
  for (let index = 0; index <= AGGREGATES.maxPublicModels; index++)
    insertReceipt(database, { model: `model/${index}` });
  insertReceipt(database, { model: 'model/top' });
  insertReceipt(database, { model: 'model/top' });
  const at = Date.parse(`${DAY}T05:00:00.000Z`);
  const buyer = insertEnvelope(database, 'buyer', at);
  for (let index = 0; index <= AGGREGATES.maxPublicDemandPerDay; index++)
    insertObservation(database, buyer, {
      type: 'unserved',
      at,
      model: `want/${index}`,
    });
  insertObservation(database, buyer, {
    type: 'unserved',
    at,
    model: 'want/top',
  });
  insertObservation(database, buyer, {
    type: 'unserved',
    at,
    model: 'want/top',
  });
  await runAggregation(database, NOW);
  const app = collector(database, NOW);
  const models = await get(app, `/v1/stats/models?from=${DAY}&to=${DAY}`);
  assert.equal(models.body.models.length, AGGREGATES.maxPublicModels);
  assert.equal(models.body.models[0]!.modelId, 'model/top');
  const network = await get(app, `/v1/stats/network?from=${DAY}&to=${DAY}`);
  const demand = network.body.days[0]!.demand;
  assert.equal(demand.length, AGGREGATES.maxPublicDemandPerDay);
  assert.equal(demand[0]!.modelId, 'want/top');
});

void test('models carry buyer first token and engine speed per side, from joined observations', async () => {
  const database = createCollectorD1();
  const requestId = 'e5'.padEnd(32, '0');
  insertReceipt(database, { requestId, paid: true, payer: 'Wallet' });
  insertReceipt(database);
  const at = Date.parse(`${DAY}T03:00:00.000Z`);
  const event = { at, requestId, sellerNodeId: SELLER_A, buyerNodeId: BUYER };
  insertObservation(database, insertEnvelope(database, 'buyer', at), {
    ...event,
    type: 'first_token',
    streaming: true,
    firstTokenMs: 800,
  });
  insertObservation(database, insertEnvelope(database, 'seller', at), {
    ...event,
    type: 'completed',
    usage: { outputTokens: 90 },
    generationMs: 1000,
  });
  await runAggregation(database, NOW);
  const { body } = await get(
    collector(database, NOW),
    `/v1/stats/models?from=${DAY}&to=${DAY}`,
  );
  const [model] = body.models;
  assert.equal(model!.free.observed, null);
  const observed = model!.paid.observed!;
  assert.equal(observed.buyerFirstToken.samples, 1);
  assert.equal(observed.buyerFirstToken.p50Ms, 1000);
  assert.equal(observed.engineSpeed.samples, 1);
  // 90 tokens per second falls in the bucket from 50 up to 100: published as at least 50.
  assert.equal(observed.engineSpeed.p50MinTokensPerSecond, 50);
  assert.deepEqual(
    observed.engineSpeed.bucketsTokensPerSecond,
    AGGREGATES.tokensPerSecondBuckets,
  );
});

void test('all-time stats start at the first eligible aggregate and keep buyer thresholds', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  await runAggregation(database, NOW);
  const end = '2027-04-01';
  const app = collector(database, Date.parse(end));
  for (const route of ['network', 'models', `sellers/${SELLER_A}`]) {
    const { body, status } = await get(
      app,
      `/v1/stats/${route}?range=all&to=${end}`,
    );
    assert.equal(status, 200);
    assert.deepEqual(
      [body.range, body.from, body.to, body.historyAvailable],
      ['all', DAY, end, true],
    );
    if (route === 'network') {
      assert.ok(body.days.length > AGGREGATES.maxRangeDays);
      assert.equal(body.days[0]?.free.buyers, null);
      assert.equal(body.days[0]?.free.withheld, true);
    }
  }
  for (const route of ['chain', `sellers/${SELLER_B}`]) {
    const { body } = await get(app, `/v1/stats/${route}?range=all&to=${end}`);
    assert.deepEqual(
      [body.from, body.to, body.historyAvailable],
      [end, end, false],
    );
  }
  const before = '2026-01-01';
  const empty = await get(app, `/v1/stats/network?range=all&to=${before}`);
  assert.deepEqual(
    [empty.body.from, empty.body.to, empty.body.historyAvailable],
    [before, before, false],
  );
  for (const tail of [
    '&from=2026-11-01',
    '&to=9999-01-01',
    '&range=all',
    '&to=2026-02-30',
  ]) {
    assert.equal(
      (await get(app, `/v1/stats/network?range=all${tail}`)).status,
      400,
    );
  }
});
