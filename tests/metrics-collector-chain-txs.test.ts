import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANNEL_PROGRAM,
  DEVNET,
  DEVNET_GYBLOS_TREASURY,
  DEVNET_USDC,
} from '@gyblos/config/network';
import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import { COLLECTOR_LIMITERS } from '@gyblos/metrics-collector/constants';
import type { ChainStats } from '@gyblos/metrics-collector/stats-chain';
import type { ChainTxPage } from '@gyblos/metrics-collector/stats-chain-txs';
import { chainTxReader } from '@gyblos/metrics-collector/stats-chain-txs-read';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { fakeLimiter } from './support/metrics-collector';
import { endpoints, fakeChainRpc } from './support/metrics-collector-chain';
import {
  channel,
  delta,
  instruction,
  lifecycle,
  OTHER_MINT,
  tx,
} from './support/metrics-collector-chain-rows';
import {
  createCollectorD1,
  type SqliteD1,
} from './support/metrics-collector-d1';

const ORIGIN = 'https://collector.test';
const ROUTE = '/v1/stats/chain/txs';
const sig = (label: string) => label.padEnd(87, 'z');
const SELLER_OWNER = 'SeLLerOwner1111111111111111111111111111111';
const FEE_PAYER = 'FeePayer11111111111111111111111111111111111';

function collector(
  database: SqliteD1,
  options: { withReader?: boolean; read?: boolean } = {},
) {
  const read = fakeLimiter(options.read ?? true);
  const ip = fakeLimiter();
  const app = createMetricsCollector({
    storage: createD1Storage(database),
    stats: statsReader(database),
    ...(options.withReader === false
      ? {}
      : { chainTransactions: chainTxReader(database) }),
    limiters: {
      [COLLECTOR_LIMITERS.IP]: ip,
      [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
      [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
      [COLLECTOR_LIMITERS.READ]: read,
    },
    now: () => Date.UTC(2026, 10, 20),
  });
  return { app, read, ip };
}
async function get(app: ReturnType<typeof collector>['app'], query = '') {
  const response = await app.request(`${ORIGIN}${ROUTE}${query}`);
  return {
    status: response.status,
    cache: response.headers.get('Cache-Control'),
    body: (await response.json()) as ChainTxPage & { error?: string },
  };
}

function seeded() {
  const database = createCollectorD1();
  channel(database, 'G', { payee: FEE_PAYER, mint: DEVNET_USDC });
  database.raw
    .prepare(
      'UPDATE collector_chain_channels SET recipients_json = ? WHERE channel = ?',
    )
    .run(
      JSON.stringify([
        { owner: SELLER_OWNER, bps: 9600 },
        { owner: DEVNET_GYBLOS_TREASURY, bps: 400 },
      ]),
      'G',
    );
  channel(database, 'N', { payee: FEE_PAYER, mint: DEVNET_USDC, gyblos: 0 });
  channel(database, 'L', { payee: FEE_PAYER, mint: OTHER_MINT });
  const at = Date.UTC(2026, 10, 10);
  const add = (
    label: string,
    slot: number,
    rows: [string, string, { amount?: string; cumulative?: string }?][],
  ) => {
    tx(database, sig(label), at + slot * 1000, 1, { slot });
    rows.forEach(([kind, address, amounts], index) =>
      instruction(database, sig(label), index, kind, address, amounts ?? {}),
    );
  };
  add('A', 100, [['open', 'G', { amount: '1000' }]]);
  add('B', 110, [['top_up', 'G', { amount: '500' }]]);
  add('C', 120, [['settle', 'G', { cumulative: '300' }]]);
  add('D', 130, [['settle', 'G', { cumulative: '200' }]]);
  add('E', 140, [
    ['settle_and_seal', 'G', { cumulative: '2000' }],
    ['distribute', 'G'],
  ]);
  delta(database, sig('E'), 'G', '-1500');
  delta(database, sig('E'), SELLER_OWNER, '1440');
  add('N1', 145, [['open', 'N', { amount: '999' }]]);
  add('L1', 146, [['open', 'L', { amount: '77' }]]);
  add('Fa', 150, [['reclaim', 'G']]);
  add('Fb', 150, [['request_close', 'G']]);
  return database;
}

const EXPECTED = [
  ['Fb', 0, 'request_close', 'G', null],
  ['Fa', 0, 'reclaim', 'G', null],
  ['L1', 0, 'open', 'L', null],
  ['E', 1, 'distribute', 'G', '1500'],
  ['E', 0, 'settle_and_seal', 'G', '1200'],
  ['D', 0, 'settle', 'G', '0'],
  ['C', 0, 'settle', 'G', '300'],
  ['B', 0, 'top_up', 'G', '500'],
  ['A', 0, 'open', 'G', '1000'],
] as const;
const summary = (rows: ChainTxPage['transactions']) =>
  rows.map((row) => [
    row.signature,
    row.instructionIndex,
    row.kind,
    row.channel,
    row.amountAtomic,
  ]);
const expected = (rows: readonly (typeof EXPECTED)[number][]) =>
  rows.map(([label, index, kind, address, amount]) => [
    sig(label),
    index,
    kind,
    address,
    amount,
  ]);

void test('GET /v1/stats/chain/txs lists Gyblos channel instructions newest first with their amounts', async () => {
  const { app } = collector(seeded());
  const { status, cache, body } = await get(app);
  assert.equal(status, 200);
  assert.equal(cache, 'public, max-age=300');
  assert.deepEqual(
    [body.network, body.programId, body.mint, body.next],
    [DEVNET, CHANNEL_PROGRAM, DEVNET_USDC, null],
  );
  assert.deepEqual(summary(body.transactions), expected(EXPECTED));
  const open = body.transactions.at(-1)!;
  assert.deepEqual(open, {
    signature: sig('A'),
    instructionIndex: 0,
    slot: 100,
    blockTime: Date.UTC(2026, 10, 10) + 100_000,
    kind: 'open',
    channel: 'G',
    payee: FEE_PAYER,
    recipients: [SELLER_OWNER, DEVNET_GYBLOS_TREASURY],
    amountAtomic: '1000',
  });
  assert.deepEqual(body.transactions[2]!.recipients, []);
  assert.ok(body.transactions.every((row) => row.channel !== 'N'));
});

void test('pages follow the (slot, signature, instruction) cursor without gaps or repeats', async () => {
  const { app } = collector(seeded());
  const seen: ChainTxPage['transactions'] = [];
  const cursors: (string | null)[] = [];
  let query = '?limit=4';
  for (;;) {
    const { status, body } = await get(app, query);
    assert.equal(status, 200);
    assert.ok(body.transactions.length <= 4);
    seen.push(...body.transactions);
    cursors.push(body.next);
    if (!body.next) break;
    query = `?limit=4&before=${body.next}`;
  }
  assert.deepEqual(summary(seen), expected(EXPECTED));
  assert.deepEqual(cursors, [`140-${sig('E')}-1`, `110-${sig('B')}-0`, null]);
  const exact = await get(app, '?limit=9');
  assert.equal(exact.body.next, null);
  const thirds = await get(app, `?limit=3&before=130-${sig('D')}-0`);
  assert.deepEqual(
    summary(thirds.body.transactions),
    expected(EXPECTED.slice(6)),
  );
  assert.equal(thirds.body.next, null);
});

void test('the default page is 25 rows and a page holds at most 50', async () => {
  const database = createCollectorD1();
  channel(database, 'G', { mint: DEVNET_USDC });
  for (let slot = 1; slot <= 60; slot += 1) {
    tx(database, sig(`S${slot}`), slot * 1000, 1, { slot });
    instruction(database, sig(`S${slot}`), 0, 'top_up', 'G', { amount: '1' });
  }
  const { app } = collector(database);
  const first = await get(app);
  assert.equal(first.body.transactions.length, 25);
  assert.equal(first.body.transactions[0]!.slot, 60);
  assert.equal(first.body.next, `36-${sig('S36')}-0`);
  const most = await get(app, '?limit=50');
  assert.equal(most.body.transactions.length, 50);
  assert.equal(most.body.next, `11-${sig('S11')}-0`);
});

void test('a malformed, unknown or repeated query parameter answers 400 INVALID_QUERY uncached', async () => {
  const { app } = collector(seeded());
  for (const query of [
    '?limit=0',
    '?limit=51',
    '?limit=01',
    '?limit=abc',
    '?limit=',
    '?limit=1&limit=2',
    '?before=nope',
    `?before=1-${sig('A')}`,
    `?before=1-${sig('A')}-x`,
    `?before=1-${sig('A')}-1000`,
    `?before=1234567890123456-${sig('A')}-0`,
    `?before=1-${'0'.repeat(87)}-0`,
    `?before=1-${sig('A')}-0&before=1-${sig('A')}-0`,
    '?from=2026-11-01',
  ]) {
    const { status, cache, body } = await get(app, query);
    assert.equal(status, 400, query);
    assert.equal(cache, 'no-store', query);
    assert.deepEqual(body, { error: 'INVALID_QUERY' }, query);
  }
});

void test('the route only reads, spends the read budget, and fails closed without a reader', async () => {
  const database = seeded();
  const { app, read, ip } = collector(database);
  database.log.length = 0;
  assert.equal((await get(app, `?before=150-${sig('Fa')}-0`)).status, 200);
  assert.ok(database.log.length > 0);
  for (const entry of database.log)
    assert.match(entry.sql.trimStart(), /^select /i);
  assert.equal(read.keys.length, 1);
  assert.equal(ip.keys.length, 0);
  const limited = collector(database, { read: false });
  assert.equal((await get(limited.app)).status, 429);
  const missing = collector(database, { withReader: false });
  const answer = await get(missing.app);
  assert.deepEqual(
    [answer.status, answer.body],
    [503, { error: 'COLLECTOR_UNAVAILABLE' }],
  );
});

void test('the real devnet lifecycle lists its instructions with the amounts the chain stats sum', async () => {
  const database = createCollectorD1();
  await runChainIndex(
    database,
    endpoints(fakeChainRpc(lifecycle(DEVNET_USDC)).rpc),
    1000,
  );
  await runAggregation(database, 2000);
  const { app } = collector(database);
  const { body } = await get(app);
  assert.deepEqual(
    body.transactions.map((row) => row.kind),
    ['reclaim', 'distribute', 'settle_and_seal', 'open'],
  );
  const stats = (await (
    await app.request(`${ORIGIN}/v1/stats/chain?from=2026-11-01&to=2026-11-20`)
  ).json()) as ChainStats;
  const usdc = stats.days.flatMap((day) =>
    day.gyblosClaimed ? [day.gyblosClaimed.usdc] : [],
  );
  const sum = (values: (string | null | undefined)[]) =>
    values.reduce((total, value) => total + BigInt(value ?? 0), 0n);
  const amountOf = (kind: string) =>
    body.transactions.find((row) => row.kind === kind)!.amountAtomic;
  assert.equal(
    BigInt(amountOf('open')!),
    sum(usdc.map((day) => day.depositedAtomic)),
  );
  assert.equal(
    BigInt(amountOf('settle_and_seal')!),
    sum(usdc.map((day) => day.settledAtomic)),
  );
  assert.equal(
    sum([amountOf('distribute'), amountOf('reclaim')]),
    sum(usdc.map((day) => day.depositedAtomic)),
  );
});
