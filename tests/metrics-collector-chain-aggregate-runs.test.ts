// Protects the chain aggregate runs (#349): a new settle re-marks only its own day while an older one
// read later re-marks the days after it; a late open or Gyblos claim recomputes the channel's earlier
// days; a failing chain day never holds back receipt aggregates; days indexed before the first chain
// scan are aggregated; and GET /v1/stats/chain answers every day of the range with the index state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_USDC } from '@gyblos/config/network';
import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import {
  AGGREGATES,
  CHAIN_INDEX,
  COLLECTOR_LIMITERS,
} from '@gyblos/metrics-collector/constants';
import type { ChainStats } from '@gyblos/metrics-collector/stats-chain';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { fakeLimiter } from './support/metrics-collector';
import {
  insertReceipt,
  NOW,
  DAY as RECEIPT_DAY,
} from './support/metrics-collector-aggregates';
import { endpoints, fakeChainRpc } from './support/metrics-collector-chain';
import {
  chainRows,
  channel,
  day,
  DAY_MS,
  DAY1,
  delta,
  fund,
  instruction,
  LAB_MINT,
  lifecycle,
  OTHER_MINT,
  tx,
} from './support/metrics-collector-chain-rows';
import {
  createCollectorD1,
  type SqliteD1,
} from './support/metrics-collector-d1';

function collector(database: SqliteD1, now: number) {
  return createMetricsCollector({
    storage: createD1Storage(database),
    stats: statsReader(database),
    limiters: {
      [COLLECTOR_LIMITERS.IP]: fakeLimiter(),
      [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
      [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
      [COLLECTOR_LIMITERS.READ]: fakeLimiter(),
    },
    now: () => now,
  });
}

void test('a new settle marks only its own day; an older one read later marks the days after it', async () => {
  const database = createCollectorD1();
  channel(database, 'S', { payer: 'p', payee: 's', mint: DEVNET_USDC });
  fund(database, 'S');
  tx(database, 's2', DAY1 + 2 * DAY_MS, 1, { slot: 300 });
  instruction(database, 's2', 0, 'settle', 'S', { cumulative: '50' });
  tx(database, 's3', DAY1 + 3 * DAY_MS, 1, { slot: 400 });
  instruction(database, 's3', 0, 'settle', 'S', { cumulative: '80' });
  const first = DAY1 + 10 * DAY_MS;
  await runAggregation(database, first);

  // Forward: a newer settle re-marks nothing older.
  const forward = first + 4 * AGGREGATES.scanOverlapMs;
  tx(database, 's4', DAY1 + 4 * DAY_MS, forward, { slot: 500 });
  instruction(database, 's4', 0, 'settle', 'S', { cumulative: '90' });
  const newer = await runAggregation(database, forward + 1);
  assert.deepEqual(newer.chain.days, [day(DAY1 + 4 * DAY_MS)]);

  // History: an older settle changes every later day of the channel.
  const backfill = forward + 4 * AGGREGATES.scanOverlapMs;
  tx(database, 's1', DAY1 + DAY_MS, backfill, { slot: 200 });
  instruction(database, 's1', 0, 'settle', 'S', { cumulative: '20' });
  const older = await runAggregation(database, backfill + 1);
  assert.deepEqual(older.chain.days, [
    day(DAY1 + 4 * DAY_MS),
    day(DAY1 + 3 * DAY_MS),
    day(DAY1 + 2 * DAY_MS),
    day(DAY1 + DAY_MS),
  ]);
  assert.deepEqual(
    chainRows(database, 'gyblos').map((row) => row.settled_atomic),
    ['20', '30', '30', '10'],
  );
});

void test('a chain day that fails never holds back the receipt aggregates', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  tx(database, 'c1', NOW - 1000, 1);
  instruction(database, 'c1', 0, 'open', 'C1', { amount: '1' });
  database.raw.exec('DROP TABLE collector_agg_chain_daily');
  const result = await runAggregation(database, NOW);
  assert.deepEqual(
    [result.days, result.failed, result.chain.failed],
    [[RECEIPT_DAY], [], [day(NOW - 1000)]],
  );
  // The chain day stays dirty for the next run.
  assert.deepEqual(
    database
      .rows('SELECT day FROM collector_agg_chain_dirty_days')
      .map((row) => row.day),
    [day(NOW - 1000)],
  );
});

void test('a late open or Gyblos claim recomputes the channel days already aggregated', async () => {
  const database = createCollectorD1();
  const later = DAY1 + 5 * DAY_MS;
  // History read newest first: the settle arrives before its channel's open.
  channel(database, 'D', { gyblos: 0 });
  // Indexed well before the first run, so the next scan no longer sees it as new.
  tx(database, 's1', DAY1 + DAY_MS, later - 2 * AGGREGATES.scanOverlapMs);
  instruction(database, 's1', 0, 'settle', 'D', { cumulative: '30' });
  await runAggregation(database, later);
  // Not a Gyblos channel yet: no Gyblos row.
  assert.deepEqual(chainRows(database, 'gyblos'), []);

  // Well past the scan overlap, the open (a day earlier, claiming Gyblos) is indexed: the settle's day
  // is recomputed only because it belongs to the same channel.
  const next = later + 4 * AGGREGATES.scanOverlapMs;
  channel(database, 'D', {
    payer: 'payer',
    payee: 'seller',
    mint: DEVNET_USDC,
    gyblos: 1,
  });
  tx(database, 'o1', DAY1, next);
  instruction(database, 'o1', 0, 'open', 'D', { amount: '90' });
  const result = await runAggregation(database, next + 1);
  assert.deepEqual(result.chain.days, [day(DAY1 + DAY_MS), day(DAY1)]);
  assert.deepEqual(
    chainRows(database, 'gyblos').map((row) => [
      row.day,
      row.deposited_atomic,
      row.settled_atomic,
    ]),
    [
      [day(DAY1), '90', '0'],
      [day(DAY1 + DAY_MS), '0', '30'],
    ],
  );
});

void test('days indexed before the first chain scan are all aggregated', async () => {
  const database = createCollectorD1();
  channel(database, 'E', { mint: DEVNET_USDC });
  tx(database, 'old', DAY1, 1);
  instruction(database, 'old', 0, 'open', 'E', { amount: '5' });
  // The receipt scan cursor is already far past these rows; the chain scan has its own.
  database.raw
    .prepare(
      'INSERT INTO collector_agg_state (id, scanned_at, formula_version) VALUES (1, ?, ?)',
    )
    .run(DAY1 + 10 * DAY_MS, AGGREGATES.formulaVersion);
  const result = await runAggregation(database, DAY1 + 10 * DAY_MS + 1);
  assert.deepEqual(result.chain.days, [day(DAY1)]);
  assert.equal(chainRows(database, 'gyblos').length, 1);
});

void test('a failing chain scan never stops the receipt aggregates', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  database.raw.exec('DROP TABLE collector_agg_chain_dirty_days');
  const result = await runAggregation(database, NOW);
  assert.deepEqual(
    [result.days, result.failed, result.chain.scanFailed],
    [[RECEIPT_DAY], [], true],
  );
});

void test('every chain mark reads through an index, never a whole chain table', async () => {
  const database = createCollectorD1();
  await runAggregation(database, DAY1);
  const marks = database.log.filter((entry) =>
    entry.sql.startsWith('insert into "collector_agg_chain_dirty_days"'),
  );
  assert.equal(marks.length, 3);
  for (const entry of marks) {
    const plan = (
      database.raw
        .prepare(`EXPLAIN QUERY PLAN ${entry.sql}`)
        .all(...entry.params) as { detail: string }[]
    ).map((row) => row.detail);
    // Only the small derived table of fresh channels may be scanned.
    assert.deepEqual(
      plan.filter((detail) => detail.startsWith('SCAN') && detail !== 'SCAN f'),
      [],
    );
  }
});

void test('a top-up read later raises the cap of the channel earlier settles', async () => {
  const database = createCollectorD1();
  channel(database, 'T', { payer: 'p', payee: 's', mint: DEVNET_USDC });
  tx(database, 't0', DAY1, 1, { slot: 1 });
  instruction(database, 't0', 0, 'open', 'T', { amount: '100' });
  tx(database, 't1', DAY1 + 1, 1, { slot: 2 });
  instruction(database, 't1', 0, 'settle', 'T', { cumulative: '150' });
  const first = DAY1 + 10 * DAY_MS;
  await runAggregation(database, first);
  assert.equal(chainRows(database, 'gyblos')[0]!.settled_atomic, '100');
  const later = first + 4 * AGGREGATES.scanOverlapMs;
  tx(database, 't2', DAY1 + DAY_MS, later, { slot: 3 });
  instruction(database, 't2', 0, 'top_up', 'T', { amount: '100' });
  const result = await runAggregation(database, later + 1);
  assert.deepEqual(result.chain.days, [day(DAY1 + DAY_MS), day(DAY1)]);
  assert.equal(chainRows(database, 'gyblos')[0]!.settled_atomic, '150');
});

void test('the chain scan cost follows new transactions, not a channel history', async () => {
  const database = createCollectorD1();
  channel(database, 'L', { payer: 'p', payee: 's', mint: DEVNET_USDC });
  fund(database, 'L');
  const insertTx = database.raw.prepare(
    'INSERT INTO collector_chain_txs (signature, slot, block_time, failed, undecodable, memo, indexed_at) VALUES (?, ?, ?, 0, 0, NULL, 1)',
  );
  const insertSettle = database.raw.prepare(
    "INSERT INTO collector_chain_instructions (signature, instruction_index, kind, channel, payer, payee, mint, amount_atomic, cumulative_atomic, recipients_json) VALUES (?, 0, 'settle', 'L', NULL, NULL, NULL, NULL, ?, NULL)",
  );
  database.raw.exec('BEGIN');
  for (let index = 0; index < 5000; index += 1) {
    insertTx.run(`l${index}`, index, DAY1 + index);
    insertSettle.run(`l${index}`, String(index + 1));
  }
  database.raw.exec('COMMIT');
  const first = DAY1 + 10 * DAY_MS;
  await runAggregation(database, first);
  // A new settle on the same long channel, then an unrelated transaction.
  const later = first + 4 * AGGREGATES.scanOverlapMs;
  tx(database, 'new', DAY1 + 5 * DAY_MS, later, { slot: 10_000 });
  instruction(database, 'new', 0, 'settle', 'L', { cumulative: '6000' });
  const started = performance.now();
  const result = await runAggregation(database, later + 1);
  assert.equal(result.chain.scanFailed, false);
  assert.deepEqual(result.chain.days, [day(DAY1 + 5 * DAY_MS)]);
  // A quadratic scan took seconds here; the bound leaves room for slow machines.
  assert.ok(performance.now() - started < 3000);
});

void test('GET /v1/stats/chain answers every day with program counts, Gyblos detail and the index state', async () => {
  const database = createCollectorD1();
  await runChainIndex(
    database,
    endpoints(fakeChainRpc(lifecycle(DEVNET_USDC)).rpc),
    1000,
  );
  await runAggregation(database, 2000);
  const app = collector(database, Date.UTC(2026, 10, 3, 12));
  const response = await app.request(
    'https://collector.test/v1/stats/chain?from=2026-11-01&to=2026-11-03',
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300');
  const body = (await response.json()) as ChainStats;
  assert.deepEqual(
    [
      body.from,
      body.to,
      body.formulaVersion,
      body.aggregatedAt,
      body.mint,
      body.index,
    ],
    [
      '2026-11-01',
      '2026-11-03',
      AGGREGATES.formulaVersion,
      2000,
      DEVNET_USDC,
      {
        backfillDone: true,
        updatedAt: 1000,
        historyFloorMs: CHAIN_INDEX.historyFloorMs,
      },
    ],
  );
  assert.deepEqual(
    body.days.map((entry) => [
      entry.day,
      entry.program?.transactions ?? null,
      entry.gyblosClaimed?.usdc.settledAtomic ?? null,
    ]),
    [
      ['2026-11-01', null, null],
      ['2026-11-02', 3, '145'],
      ['2026-11-03', null, null],
    ],
  );
  const busy = body.days[1]!;
  // The program: counts only. Gyblos: the full detail.
  assert.deepEqual(busy.program, { transactions: 3, failed: 0 });
  assert.deepEqual(busy.gyblosClaimed!.instructions, {
    open: 1,
    settle: 0,
    topUp: 0,
    settleAndSeal: 1,
    requestClose: 0,
    seal: 0,
    distribute: 1,
    reclaim: 1,
  });
  assert.equal(busy.gyblosClaimed!.undecodable, 0);

  // Before the index ever ran: no state, no days with data; a bad range is refused.
  const empty = collector(createCollectorD1(), Date.UTC(2026, 10, 3));
  const fresh = (await (
    await empty.request('https://collector.test/v1/stats/chain')
  ).json()) as ChainStats;
  assert.deepEqual(
    [fresh.index, fresh.formulaVersion, fresh.days.length],
    [null, null, 30],
  );
  const bad = await empty.request(
    'https://collector.test/v1/stats/chain?from=2026-11-05&to=2026-11-01',
  );
  assert.equal(bad.status, 400);
});
