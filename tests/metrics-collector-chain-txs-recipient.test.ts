import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_GYBLOS_TREASURY, DEVNET_USDC } from '@gyblos/config/network';
import { base58Encode } from '@gyblos/metrics-collector/chain/base58';

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
import {
  createCollectorD1,
  type SqliteD1,
} from './support/metrics-collector-d1';

const owner = (fill: number) => base58Encode(new Uint8Array(32).fill(fill));
const SELLER = owner(7);
const OTHER = owner(9);

function recipients(database: SqliteD1, address: string, owners: string[]) {
  database.raw
    .prepare(
      'UPDATE collector_chain_channels SET recipients_json = ? WHERE channel = ?',
    )
    .run(
      JSON.stringify(owners.map((entry) => ({ owner: entry, bps: 5000 }))),
      address,
    );
}

function seeded() {
  const database = createCollectorD1();
  for (const address of ['S', 'T', 'O', 'U'])
    channel(database, address, { mint: DEVNET_USDC });
  recipients(database, 'S', [SELLER, DEVNET_GYBLOS_TREASURY]);
  recipients(database, 'T', [SELLER, DEVNET_GYBLOS_TREASURY]);
  recipients(database, 'O', [OTHER, SELLER]);
  const at = Date.UTC(2026, 10, 10);
  const rows: [string, number, string, string][] = [
    ['S1', 10, 'open', 'S'],
    ['O1', 20, 'open', 'O'],
    ['T1', 30, 'open', 'T'],
    ['U1', 40, 'open', 'U'],
    ['S2', 50, 'top_up', 'S'],
    ['O2', 60, 'top_up', 'O'],
  ];
  for (const [label, slot, kind, address] of rows) {
    tx(database, sig(label), at + slot * 1000, 1, { slot });
    instruction(database, sig(label), 0, kind, address, { amount: '100' });
  }
  return database;
}

void test('recipient lists only channels whose first split recipient is that owner, paged by the cursor', async () => {
  const { app } = collector(seeded());
  const all = await get(app, `?recipient=${SELLER}`);
  assert.equal(all.status, 200);
  assert.equal(all.cache, 'public, max-age=300');
  assert.deepEqual(summary(all.body.transactions), [
    [sig('S2'), 0, 'top_up', 'S', '100'],
    [sig('T1'), 0, 'open', 'T', '100'],
    [sig('S1'), 0, 'open', 'S', '100'],
  ]);
  assert.ok(all.body.transactions.every((row) => row.recipients[0] === SELLER));
  const first = await get(app, `?limit=2&recipient=${SELLER}`);
  assert.equal(first.body.next, `30-${sig('T1')}-0`);
  const rest = await get(
    app,
    `?before=${first.body.next}&limit=2&recipient=${SELLER}`,
  );
  assert.deepEqual(summary(rest.body.transactions), [
    [sig('S1'), 0, 'open', 'S', '100'],
  ]);
  assert.equal(rest.body.next, null);
  const other = await get(app, `?recipient=${OTHER}`);
  assert.deepEqual(
    other.body.transactions.map((row) => row.channel),
    ['O', 'O'],
  );
  const none = await get(app, `?recipient=${owner(11)}`);
  assert.deepEqual([none.body.transactions, none.body.next], [[], null]);
});

void test('a malformed, repeated or misplaced recipient answers 400 INVALID_QUERY uncached', async () => {
  const { app } = collector(seeded());
  for (const query of [
    '?recipient=',
    '?recipient=abc',
    `?recipient=${SELLER.slice(0, -1)}0`,
    `?recipient=${SELLER.slice(0, -1)}O`,
    `?recipient=${SELLER.slice(0, -1)}l`,
    `?recipient=1${SELLER}`,
    `?recipient=${base58Encode(new Uint8Array(31).fill(7))}`,
    `?recipient=${base58Encode(new Uint8Array(33).fill(7))}`,
    `?recipient=${SELLER}&recipient=${SELLER}`,
    `?recipient=${SELLER}&limit=4`,
    `?recipient=${SELLER}&before=30-${sig('T1')}-0`,
    `?limit=4&before=30-${sig('T1')}-0&recipient=${SELLER}`,
    `?recipient=${'2'.repeat(45)}`,
  ]) {
    const { status, cache, body } = await get(app, query);
    assert.equal(status, 400, query);
    assert.equal(cache, 'no-store', query);
    assert.deepEqual(body, { error: 'INVALID_QUERY' }, query);
  }
});

void test('a filtered page is still one read-only statement limited before its amounts', async () => {
  const database = seeded();
  const { app } = collector(database);
  database.log.length = 0;
  const answer = await get(
    app,
    `?before=50-${sig('S2')}-0&limit=2&recipient=${SELLER}`,
  );
  assert.equal(answer.status, 200);
  assert.equal(database.log.length, 1);
  const statement = database.log[0]!.sql;
  assert.match(
    statement.trimStart(),
    /^with "page" as \(select [\s\S]*\) select [\s\S]* from "page" /i,
  );
  assert.doesNotMatch(
    statement,
    /\b(insert|update|delete|replace|upsert|create|drop|alter)\b/i,
  );
  assert.equal(statement.match(/\blimit\b/gi)?.length, 1);
  const lower = statement.toLowerCase();
  assert.ok(lower.search(/\blimit\b/) < lower.indexOf('from "page"'));
  assert.ok(!statement.includes(SELLER));
});
