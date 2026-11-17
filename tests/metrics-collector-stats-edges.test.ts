// Protects the collector's edges around the stats API (#351): separate read and upload budgets, upload
// plausibility bounds, the edge cache, the scheduled entry and malformed stored histograms.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import {
  AGGREGATES,
  COLLECTOR_DB_BINDING,
  COLLECTOR_LIMITERS,
  COLLECTOR_LIMITS,
} from '@gyblos/metrics-collector/constants';
import { plausibleReceipt } from '@gyblos/metrics-collector/ingest';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { counts, latency } from '@gyblos/metrics-collector/stats-shape';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';
import {
  cachedFetch,
  scheduledAggregation,
} from '@gyblos/metrics-collector/worker';
import { signSellerReceipt } from '@gyblos/protocol/receipt';

import { fakeLimiter, signUpload } from './support/metrics-collector';
import {
  DAY,
  insertReceipt,
  NOW,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';
import { receiptSigner, sellerRecord } from './support/receipt-fixture';
import { sellerUpload, T0 } from './support/receipt-upload';

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
}
interface Answer {
  error?: string;
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

void test('stats reads spend the read budget, uploads the per-address one, and health stays no-store', async () => {
  const limiters = {
    [COLLECTOR_LIMITERS.IP]: fakeLimiter(),
    [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
    [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
    [COLLECTOR_LIMITERS.READ]: fakeLimiter(false),
  };
  const app = collector(createCollectorD1(), NOW, true, limiters);
  assert.equal((await get(app, '/v1/stats/network')).status, 429);
  const health = await app.request(`${ORIGIN}/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(limiters[COLLECTOR_LIMITERS.READ].keys.length, 1);
  assert.equal(limiters[COLLECTOR_LIMITERS.IP].keys.length, 1);
});

void test('a receipt with an implausible time, amount or token count is refused at upload', async () => {
  const database = createCollectorD1();
  const app = collector(database, T0);
  const seller = receiptSigner();
  const base = sellerRecord(seller.nodeId, receiptSigner().nodeId);
  const cases = [
    {
      ...base,
      timing: {
        ...base.timing,
        receivedAt: T0 + COLLECTOR_LIMITS.receiptClockSkewMs + 1,
      },
    },
    {
      ...base,
      timing: {
        ...base.timing,
        receivedAt: T0 - COLLECTOR_LIMITS.maxReceiptAgeMs - 1,
      },
    },
    {
      ...base,
      usage: {
        ...base.usage,
        inputTokens: COLLECTOR_LIMITS.maxReceiptTokens + 1,
      },
    },
  ];
  for (const [index, record] of cases.entries()) {
    const receipt = { seller: await signSellerReceipt(record, seller.sign) };
    const upload = {
      ...sellerUpload(seller.nodeId, receipt),
      nonce: index.toString(16).padStart(32, '0'),
    };
    const response = await app.request(`${ORIGIN}/v1/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await signUpload(upload, seller.sign)),
    });
    assert.equal(response.status, 400, String(index));
  }
  assert.equal(database.rows('SELECT * FROM collector_receipts').length, 0);
});

void test('the edge cache serves repeated stats answers and stores only successful stats GETs', async () => {
  const stored = new Map<string, Response>();
  const cache = {
    match: (request: Request) =>
      Promise.resolve(stored.get(request.url)?.clone()),
    put: (request: Request, response: Response) => {
      stored.set(request.url, response);
      return Promise.resolve();
    },
  };
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
  };
  let calls = 0;
  const answer = (status: number) => () => {
    calls += 1;
    return new Response('{}', { status });
  };
  const url = `${ORIGIN}/v1/stats/network`;
  await cachedFetch(new Request(url), cache, context, answer(200));
  await Promise.all(pending);
  await cachedFetch(new Request(url), cache, context, answer(200));
  assert.equal(calls, 1);
  await cachedFetch(new Request(`${url}?to=bad`), cache, context, answer(400));
  await cachedFetch(
    new Request(`${ORIGIN}/v1/health`),
    cache,
    context,
    answer(200),
  );
  await Promise.all(pending);
  assert.deepEqual([...stored.keys()], [url]);
});

void test('the scheduled run aggregates with a database and does nothing without one', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  assert.equal(await scheduledAggregation({}, NOW), undefined);
  const run = await scheduledAggregation(
    { [COLLECTOR_DB_BINDING]: database },
    NOW,
  );
  assert.deepEqual(run?.days, [DAY]);
});

void test('a malformed stored histogram reads as empty and a percentile above the last bound is null', () => {
  assert.deepEqual(
    counts('not json'),
    Array(AGGREGATES.latencyBucketsMs.length + 1).fill(0),
  );
  const above = Array<number>(AGGREGATES.latencyBucketsMs.length + 1).fill(0);
  above[above.length - 1] = 3;
  const shaped = latency(JSON.stringify(above));
  assert.deepEqual(
    [shaped.samples, shaped.p50Ms, shaped.p95Ms],
    [3, null, null],
  );
});

void test('receipt amounts and fees above the ceiling are implausible; a recent skewed time is not', () => {
  const entry = (record: object) =>
    ({ receipt: { seller: { record } } }) as unknown as Parameters<
      typeof plausibleReceipt
    >[0];
  const base = sellerRecord();
  const over = String(COLLECTOR_LIMITS.maxReceiptAtomic + 1);
  const sentAt = base.timing.receivedAt;
  assert.equal(plausibleReceipt(entry(base), sentAt), true);
  assert.equal(
    plausibleReceipt(entry({ ...base, amountAtomic: over }), sentAt),
    false,
  );
  assert.equal(
    plausibleReceipt(entry({ ...base, feeAtomic: over }), sentAt),
    false,
  );
  // A seller clock up to receiptClockSkewMs ahead of the uploader's is accepted.
  assert.equal(
    plausibleReceipt(entry(base), sentAt - COLLECTOR_LIMITS.receiptClockSkewMs),
    true,
  );
});
