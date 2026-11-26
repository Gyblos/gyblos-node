import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_GYBLOS_TREASURY } from '@gyblos/config/network';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import { COLLECTOR_LIMITERS } from '@gyblos/metrics-collector/constants';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { COLLECTOR_ORIGIN, fakeLimiter } from './support/metrics-collector';
import {
  DAY,
  DAY_START,
  HOUR,
  insertReceipt,
  NOW,
} from './support/metrics-collector-aggregates';
import {
  channel,
  delta,
  instruction,
  tx,
} from './support/metrics-collector-chain-rows';
import { createCollectorD1 } from './support/metrics-collector-d1';

function fixture() {
  const db = createCollectorD1();
  const app = createMetricsCollector({
    storage: createD1Storage(db),
    stats: statsReader(db),
    limiters: Object.fromEntries(
      Object.values(COLLECTOR_LIMITERS).map((key) => [key, fakeLimiter()]),
    ),
    now: () => NOW,
  });
  const get = (query: string) =>
    app.request(`${COLLECTOR_ORIGIN}/v1/stats/intraday?${query}`);
  return { db, get };
}

void test('intraday groups signed headline usage and balanced Gyblos seller payouts by UTC half hour', async () => {
  const { db, get } = fixture();
  insertReceipt(db, {
    receivedAt: DAY_START,
    inputTokens: 5,
    outputTokens: 7,
    model: 'private-canary',
  });
  insertReceipt(db, {
    receivedAt: DAY_START + HOUR / 2 - 1,
    status: 'seller-only',
    paid: true,
    inputTokens: 2,
    outputTokens: 3,
  });
  insertReceipt(db, {
    receivedAt: DAY_START + HOUR / 2,
    inputTokens: 0,
    outputTokens: 0,
  });
  insertReceipt(db, {
    receivedAt: DAY_START + HOUR / 2,
    status: 'disputed',
    inputTokens: 999,
    outputTokens: 999,
  });
  insertReceipt(db, { receivedAt: DAY_START + 24 * HOUR });
  insertReceipt(db, { receivedAt: DAY_START - 1 });
  channel(db, 'vault', { payer: 'buyer', payee: 'seller' });
  channel(db, 'other', { gyblos: 0 });
  for (const [signature, stamp, paid, release] of [
    ['first', DAY_START, '80', '100'],
    ['another', DAY_START + HOUR, '40', '60'],
    ['unbalanced', DAY_START + HOUR, '100', '1'],
    ['mixed', DAY_START, '90', '110'],
  ] as const) {
    tx(db, signature, stamp, NOW);
    instruction(db, signature, 0, 'distribute', 'vault');
    if (signature === 'mixed')
      instruction(db, signature, 1, 'distribute', 'other');
    delta(db, signature, 'vault', '-' + release);
    delta(db, signature, 'seller', paid);
    delta(db, signature, DEVNET_GYBLOS_TREASURY, '20');
  }
  const response = await get(`from=${DAY}&to=${DAY}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(db.log.length, 2);
  assert.equal(db.log[0]?.batch, db.log[1]?.batch);
  for (const [index, statement] of db.log.entries()) {
    const plan = db.raw
      .prepare('EXPLAIN QUERY PLAN ' + statement.sql)
      .all(...statement.params);
    const indexName =
      index === 0
        ? 'collector_receipts_by_received'
        : 'collector_chain_txs_by_time';
    assert.ok(plan.some((row) => String(row.detail).includes(indexName)));
  }
  assert.deepEqual(await response.json(), {
    rows: [
      { at: DAY_START, tokens: 17, requests: 2, paidOut: '80' },
      { at: DAY_START + HOUR / 2, tokens: 0, requests: 1, paidOut: '0' },
      { at: DAY_START + HOUR, tokens: 0, requests: 0, paidOut: '40' },
    ],
  });
});

void test('intraday allows up to seven closed UTC days and rejects open, duplicate, missing or selective parameters before reading', async () => {
  const { db, get } = fixture();
  for (const query of [
    '',
    'from=' + DAY,
    'to=' + DAY,
    'to=2026-11-17&from=' + DAY,
    'from=2026-11-09&to=' + DAY,
    'from=2026-02-31&to=2026-03-01',
    'from=2026-11-17&to=' + DAY,
    `from=${DAY}&to=${DAY}&from=${DAY}`,
    `from=${DAY}&to=${DAY}&model=x`,
  ]) {
    const response = await get(query);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(db.log.length, 0);
  const ok = await get('from=2026-11-10&to=' + DAY);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { rows: [] });
});
