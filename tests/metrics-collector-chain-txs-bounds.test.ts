import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_USDC } from '@gyblos/config/network';

import {
  channel,
  instruction,
  tx,
} from './support/metrics-collector-chain-rows';
import {
  collector,
  get,
  sig,
  summary,
} from './support/metrics-collector-chain-txs';
import { createCollectorD1 } from './support/metrics-collector-d1';

void test('a channel with thousands of settles still answers a page quickly and exactly', async () => {
  const database = createCollectorD1();
  channel(database, 'G', { mint: DEVNET_USDC });
  tx(database, sig('Open'), 1000, 1, { slot: 1 });
  instruction(database, sig('Open'), 0, 'open', 'G', { amount: '100000' });
  const settles = 4000;
  for (let i = 1; i <= settles; i += 1) {
    tx(database, sig(`S${i}`), 1000 + i, 1, { slot: 1 + i });
    instruction(database, sig(`S${i}`), 0, 'settle', 'G', {
      cumulative: String(i * 10),
    });
  }
  const { app } = collector(database);
  const started = performance.now();
  const { status, body } = await get(app, '?limit=50');
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.equal(body.transactions.length, 50);
  assert.ok(body.transactions.every((row) => row.amountAtomic === '10'));
  assert.ok(elapsed < 3000, `${elapsed} ms`);
});

void test('a page without settles reads no settle history of its channels', async () => {
  const database = createCollectorD1();
  channel(database, 'G', { mint: DEVNET_USDC });
  tx(database, sig('Open'), 1000, 1, { slot: 1 });
  instruction(database, sig('Open'), 0, 'open', 'G', { amount: '100000000' });
  database.raw.exec('BEGIN');
  for (let i = 1; i <= 40000; i += 1) {
    tx(database, sig(`S${i}`), 1000 + i, 1, { slot: 1 + i });
    instruction(database, sig(`S${i}`), 0, 'settle', 'G', {
      cumulative: String(i),
    });
  }
  database.raw.exec('COMMIT');
  const { app } = collector(database);
  const timed = async (query: string) => {
    const runs = [];
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      const answer = await get(app, query);
      runs.push({ ...answer, ms: performance.now() - started });
    }
    return runs.reduce((best, run) => (run.ms < best.ms ? run : best));
  };
  const newest = await timed('?limit=2');
  assert.deepEqual(
    newest.body.transactions.map((row) => row.amountAtomic),
    ['1', '1'],
  );
  const deposits = await timed(`?before=2-${sig('S1')}-0`);
  assert.deepEqual(summary(deposits.body.transactions), [
    [sig('Open'), 0, 'open', 'G', '100000000'],
  ]);
  assert.ok(
    deposits.ms < newest.ms / 4,
    `${deposits.ms} ms vs ${newest.ms} ms`,
  );
});
