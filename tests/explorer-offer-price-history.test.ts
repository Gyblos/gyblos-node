import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { DISCOVERY_URL } from '@gyblos/explorer/config';
import { getOfferPriceHistory } from '@gyblos/explorer/offer-price-history';
import { V2_PRICING } from '@gyblos/protocol/constants';

const originalFetch = globalThis.fetch;
beforeEach(() => {
  mock.method(Date, 'now', () => to + day / 2);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});
const nodeId = 'a'.repeat(64);
const model = { modelId: 'lab/model', variant: null, quantization: 'Q4' };
const pricing = {
  network: DEVNET,
  asset: DEVNET_USDC,
  unit: V2_PRICING.unit,
  inputAtomicPerMtok: '9007199254740993',
  outputAtomicPerMtok: '0',
};
const offer = { ...model, contextTokens: 2048, pricing };
const to = Date.UTC(2026, 10, 24);
const day = 86_400_000;
const from = to - day * 7;
const period = {
  nodeId,
  startedAt: from - 900,
  expiresAt: from + 2000,
  endedAt: from + 1000,
  offers: [offer],
};
const body = {
  model: model.modelId,
  generatedAt: to + day / 2,
  from: from - day / 2,
  days: 8,
  periods: [period],
  truncated: false,
};
function source(answer: unknown) {
  const requests: string[] = [];
  globalThis.fetch = (url) => {
    requests.push(String(url));
    return Promise.resolve(Response.json(answer));
  };
  return requests;
}

void test('offer history clips explicit valid periods, keeps gaps and exact matching devnet prices', async () => {
  const later = {
    ...period,
    startedAt: from + 3000,
    endedAt: null,
    expiresAt: from + 4000,
  };
  const requests = source({
    ...body,
    truncated: true,
    periods: [
      {
        ...later,
        offers: [
          offer,
          { ...offer, contextTokens: 4096 },
          { ...offer, variant: 'different' },
          ...[{ unit: 'token' }, { network: 'other' }, { asset: 'other' }].map(
            (change) => ({ ...offer, pricing: { ...pricing, ...change } }),
          ),
        ],
      },
      period,
    ],
  });
  const result = await getOfferPriceHistory({ model, days: 7 });
  assert.deepEqual(requests, [
    `${DISCOVERY_URL}/offers/history?model=lab%2Fmodel&days=8`,
  ]);
  assert.deepEqual(
    [result.error, result.truncated, result.from, result.to],
    [false, true, from, to],
  );
  assert.equal(result.series.length, 2);
  const points = result.series.find(
    (series) => series.contextTokens === 2048,
  )?.points;
  assert.deepEqual(
    points,
    [
      [from, from + 1000],
      [from + 3000, from + 4000],
    ].map(([at, end]) => ({ at, end, input: 9007199254740993n, output: 0n })),
  );
});

void test('offer history uses the completed UTC day for 24h and clips longer open ranges to the snapshot', async () => {
  const snapshot = to + day / 3;
  const full = {
    ...period,
    startedAt: to - 32 * day,
    endedAt: null,
    expiresAt: to + day,
  };
  for (const [days, closed, count, first, last] of [
    [1, false, 2, to - day, to],
    [7, false, 7, to - 6 * day, snapshot],
    [30, true, 31, to - 30 * day, to],
  ] as const) {
    const requests = source({
      ...body,
      days: count,
      from: snapshot - count * day,
      generatedAt: snapshot,
      periods: [full],
    });
    const result = await getOfferPriceHistory({ model, days, closed });
    assert.deepEqual(requests, [
      `${DISCOVERY_URL}/offers/history?model=lab%2Fmodel&days=${count}`,
    ]);
    assert.deepEqual(
      [
        result.from,
        result.to,
        result.series[0]?.points[0]?.at,
        result.series[0]?.points[0]?.end,
      ],
      [first, last, first, last],
    );
  }
});

void test('seller history requests the longest supported window once and stops an open offer at the snapshot', async () => {
  const requests = source({
    node: nodeId,
    days: 92,
    generatedAt: to,
    from: to - 92 * day,
    truncated: false,
    periods: [
      { ...period, startedAt: to - 100, expiresAt: to + 1000, endedAt: null },
    ],
  });
  const result = await getOfferPriceHistory({ nodeId, days: 'all' });
  assert.equal(result.error, false);
  assert.deepEqual(requests, [
    `${DISCOVERY_URL}/offers/history?node=${nodeId}&days=92`,
  ]);
  assert.equal(result.series[0]?.points[0]?.end, to);
});

void test('retained seller catalog periods establish history even without supported prices', async () => {
  source({
    ...body,
    node: nodeId,
    periods: [
      {
        ...period,
        offers: [{ ...offer, pricing: { ...pricing, asset: 'other' } }],
      },
    ],
  });
  const result = await getOfferPriceHistory({ nodeId, days: 7 });
  assert.equal(result.hasPeriods, true);
  assert.deepEqual(result.series, []);
  source({ ...body, node: nodeId, periods: [] });
  assert.equal(
    (await getOfferPriceHistory({ nodeId, days: 7 })).hasPeriods,
    false,
  );
});

void test('offer history rejects mismatched scope, malformed prices, oversized pages, and upstream failures', async () => {
  for (const invalid of [
    { ...body, model: 'wrong' },
    { ...body, days: 30 },
    { ...body, from: from - 1 },
    { ...body, periods: Array.from({ length: 51 }, () => period) },
    {
      ...body,
      periods: [
        {
          ...period,
          offers: [
            { ...offer, pricing: { ...pricing, inputAtomicPerMtok: '-4' } },
          ],
        },
      ],
    },
  ]) {
    source(invalid);
    const result = await getOfferPriceHistory({ model, days: 7 });
    assert.equal(result.error, true);
    assert.equal(result.hasPeriods, false);
    assert.deepEqual(result.series, []);
  }
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 503 }));
  assert.equal((await getOfferPriceHistory({ model, days: 7 })).error, true);
});
