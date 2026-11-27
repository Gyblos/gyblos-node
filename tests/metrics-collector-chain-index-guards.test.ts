// Protects the chain read against what makes it waste calls or lose data: a lagging node that ignores
// `until` (refused, never counted twice), an overlapping run (skipped by the lease), a failing list
// (channels are still followed and their accounts read), a channel spammed below the flood size (reads
// capped per poll), a burst of new Gyblos opens (known channels still polled), and an index that ran
// with the full-read design (its Gyblos channels are followed after migration 0006); an endpoint of
// another network hands the run on and is counted apart from rate limits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CHAIN_PHASES,
  runChainIndex,
} from '@gyblos/metrics-collector/chain/indexer';
import {
  ChainRpcError,
  WRONG_NETWORK,
  type ChainRpc,
} from '@gyblos/metrics-collector/chain/rpc';
import {
  CHAIN_CURSOR_ID,
  CHAIN_INDEX,
} from '@gyblos/metrics-collector/constants';

import {
  BLOCK_TIME_S,
  endpoints,
  failingWith,
  fakeChainRpc,
  PROGRAM,
  withSignature,
} from './support/metrics-collector-chain';
import {
  CHANNEL,
  counted,
  gyblosOpens,
  lifecycle,
  liveAccounts,
  plain,
  readCount,
  rows,
} from './support/metrics-collector-chain-index';
import { createCollectorD1 } from './support/metrics-collector-d1';

const LATER = CHAIN_INDEX.followIntervalMs;

void test('a lagging node that returns older signatures is refused, never counted twice', async () => {
  const database = createCollectorD1();
  const history = plain(5, 'old').map((entry, index) =>
    withSignature(entry.signature, undefined, { slot: 100 - index }),
  );
  const { rpc } = fakeChainRpc(history);
  await runChainIndex(database, endpoints(rpc), 1000);
  // It cannot find `until` and answers from its own older tip.
  const lagging = {
    ...rpc,
    signatures: () =>
      Promise.resolve(
        [withSignature('older', undefined, { slot: 50 })].map(
          (entry) => entry.listed,
        ),
      ),
  };
  await assert.rejects(runChainIndex(database, endpoints(lagging), 2000), {
    name: 'ChainIndexError',
  });
  assert.equal(counted(database), 5);
});

void test('a public RPC that refuses Workers (403) and a failing first key fall through to the next key', async () => {
  const database = createCollectorD1();
  const alchemy = fakeChainRpc(plain(3, 'p'));
  const result = await runChainIndex(
    database,
    endpoints(failingWith(403), 80, [
      { rpc: failingWith(503), budget: 20 },
      { rpc: alchemy.rpc, budget: 20 },
    ]),
    1000,
  );
  assert.deepEqual(
    [result.listed, result.usage.endpoint, result.usage.onFallback],
    [3, 2, true],
  );
  assert.deepEqual(result.usage.primary, {
    calls: 1,
    rateLimited: 1,
    wrongNetwork: 0,
  });
  // The failing key's one call, then the working key's.
  assert.equal(result.usage.fallback.calls, 1 + alchemy.calls.signatures);
  // A failure that is not the endpoint's (a transaction it lists but cannot return yet) never moves
  // the run: it stops there and is retried next run.
  const lagging = {
    ...alchemy.rpc,
    signatures: () =>
      Promise.reject(new ChainRpcError('transaction unavailable')),
  };
  const backup = fakeChainRpc(plain(3, 'p'));
  await assert.rejects(
    runChainIndex(
      createCollectorD1(),
      endpoints(lagging, 80, { rpc: backup.rpc, budget: 20 }),
      1000,
    ),
  );
  assert.equal(backup.calls.signatures, 0);
});

void test('an overlapping run skips while another holds the lease', async () => {
  const database = createCollectorD1();
  const { rpc, calls } = fakeChainRpc(plain(3, 'p'));
  database.raw.exec(
    `INSERT INTO collector_chain_cursor (id, gap_full, backfill_full, backfill_done, updated_at, lease_until)
       VALUES (1, 0, 0, 0, 0, ${1000 + CHAIN_INDEX.leaseMs})`,
  );
  const held = await runChainIndex(database, endpoints(rpc), 1000);
  assert.equal(held.skipped, true);
  assert.equal(calls.signatures, 0);
  // Once the lease expires (or is released), the next run reads.
  const next = await runChainIndex(
    database,
    endpoints(rpc),
    2000 + CHAIN_INDEX.leaseMs,
  );
  assert.deepEqual([next.skipped, next.listed], [false, 3]);
  assert.deepEqual(
    rows(database, 'SELECT lease_until FROM collector_chain_cursor'),
    [{ lease_until: null }],
  );
});

void test('a failing list still follows the channels and reads their accounts', async () => {
  const database = createCollectorD1();
  const opens = gyblosOpens(1);
  const { rpc, calls } = fakeChainRpc(opens, liveAccounts(opens));
  await runChainIndex(database, endpoints(rpc), 1000);
  const broken = {
    ...rpc,
    signatures: (
      address: string,
      range: { until?: string; before?: string },
    ) =>
      address === PROGRAM
        ? Promise.reject(new Error('list down'))
        : rpc.signatures(address, range),
  };
  const before = calls.signatures;
  await assert.rejects(
    runChainIndex(database, endpoints(broken), 1000 + LATER),
    {
      name: 'ChainIndexError',
    },
  );
  // The channel's list was still polled, and its account read.
  assert.equal(calls.signatures, before + 1);
  assert.deepEqual(
    rows(
      database,
      'SELECT followed_at, account_read_at FROM collector_chain_channels',
    ),
    [{ followed_at: 1000 + LATER, account_read_at: 1000 + LATER }],
  );
});

void test('a spammed channel is read at most a capped number of transactions per poll', async () => {
  const database = createCollectorD1();
  const [open] = gyblosOpens(1);
  const channel = open!.addresses[1]!;
  const history = [open!];
  const { rpc } = fakeChainRpc(history, liveAccounts(history));
  await runChainIndex(database, endpoints(rpc), 1000);
  const spam = 50;
  history.unshift(
    ...Array.from({ length: spam }, (_, index) =>
      withSignature(`spam${index}`, undefined, {
        slot: 6e8 - index,
        addresses: [PROGRAM, channel],
      }),
    ),
  );
  const first = await runChainIndex(database, endpoints(rpc), 1000 + LATER);
  assert.equal(first.read, CHAIN_INDEX.maxReadsPerChannelPoll);
  // The rest waits for later polls, oldest first, each read once.
  for (let poll = 2; poll <= 4; poll += 1)
    await runChainIndex(database, endpoints(rpc), 1000 + poll * LATER);
  assert.equal(readCount(database), 1 + spam);
});

void test('a burst of new Gyblos opens never starves the channels already known', async () => {
  const database = createCollectorD1();
  const opens = gyblosOpens(CHAIN_INDEX.maxFollowedPerRun + 1);
  const known = opens.at(-1)!;
  const history = [known];
  const { rpc } = fakeChainRpc(history, liveAccounts(opens));
  await runChainIndex(database, endpoints(rpc), 1000);
  history.unshift(...opens.slice(0, -1));
  await runChainIndex(database, endpoints(rpc), 1000 + LATER);
  const [row] = rows(
    database,
    `SELECT followed_at FROM collector_chain_channels WHERE channel = '${known.addresses[1]!}'`,
  );
  assert.equal(row!.followed_at, 1000 + LATER);
});

void test('Gyblos channels indexed before migration 0006 are followed, and the list counted again', async () => {
  const database = createCollectorD1();
  database.raw.exec(
    `INSERT INTO collector_chain_channels (channel, gyblos, status, last_signature, last_slot, updated_at)
       VALUES ('live', 1, 'open', 'sig-live', 1, 0), ('gone', 1, 'closed', 'sig-gone', 1, 0),
              ('other', 0, 'open', 'sig-other', 1, 0);
     INSERT INTO collector_chain_cursor (id, newest_signature, gap_full, backfill_full, backfill_done, updated_at)
       VALUES (1, 'old-newest', 0, 0, 1, 0);`,
  );
  const migration = readFileSync(
    new URL(
      '../apps/metrics-collector/migrations/0006_chain_gyblos_only.sql',
      import.meta.url,
    ),
    'utf8',
  );
  // The columns already exist here (every migration was applied): run only its data steps.
  database.raw.exec(
    migration.slice(migration.indexOf('UPDATE collector_chain_channels')),
  );
  assert.deepEqual(
    rows(
      database,
      'SELECT channel, following, follow_until FROM collector_chain_channels ORDER BY channel',
    ),
    [
      { channel: 'gone', following: 0, follow_until: null },
      { channel: 'live', following: 1, follow_until: 'sig-live' },
      { channel: 'other', following: 0, follow_until: null },
    ],
  );
  assert.deepEqual(rows(database, 'SELECT * FROM collector_chain_cursor'), []);
});

void test('an endpoint of another network hands the run on and is never counted as a rate limit', async () => {
  const refuse = () =>
    Promise.reject(new ChainRpcError(WRONG_NETWORK, false, true));
  const mainnet: ChainRpc = {
    signatures: refuse,
    transaction: refuse,
    accounts: refuse,
  };
  const healthy = fakeChainRpc([]);
  const run = endpoints(mainnet, 1000, { rpc: healthy.rpc, budget: 20 });
  assert.deepEqual(await run.signatures(PROGRAM, {}), []);
  const usage = run.usage();
  assert.deepEqual(usage.primary, {
    calls: 1,
    rateLimited: 0,
    wrongNetwork: 1,
  });
  assert.equal(usage.onFallback, true);
  assert.equal(usage.fallback.calls, 1);
});

void test('a run that lost its lease mid-flight never clears the new holder', async () => {
  const database = createCollectorD1();
  const history = lifecycle();
  const { rpc } = fakeChainRpc(history, { [CHANNEL]: null });
  await runChainIndex(database, endpoints(rpc), 1000);
  const foreignLease = 9_999_999;
  const takeover: ChainRpc = {
    ...rpc,
    signatures(address, range) {
      database.raw
        .prepare(
          'UPDATE collector_chain_cursor SET lease_until = ? WHERE id = ?',
        )
        .run(foreignLease, CHAIN_CURSOR_ID);
      return rpc.signatures(address, range);
    },
  };
  await runChainIndex(database, endpoints(takeover), 2000);
  assert.deepEqual(
    rows(database, 'SELECT lease_until FROM collector_chain_cursor'),
    [{ lease_until: foreignLease }],
  );
});

void test('a failing lease release never masks the run failure', async () => {
  const database = createCollectorD1();
  const history = lifecycle();
  const { rpc } = fakeChainRpc(history, { [CHANNEL]: null });
  await runChainIndex(database, endpoints(rpc), 1000);
  const prepare = database.prepare.bind(database);
  let updates = 0;
  database.prepare = (sql) => {
    if (sql.startsWith('update') && sql.includes('lease_until')) {
      updates += 1;
      if (updates === 2) {
        const failing = {
          bind: () => failing,
          all: () => Promise.reject(new Error('D1 unavailable')),
          run: () => Promise.reject(new Error('D1 unavailable')),
        };
        return failing as ReturnType<typeof prepare>;
      }
    }
    return prepare(sql);
  };
  const failingRpc: ChainRpc = {
    ...rpc,
    signatures: () => Promise.reject(new ChainRpcError('refused')),
  };
  await assert.rejects(
    runChainIndex(database, endpoints(failingRpc), 2000),
    (error) => {
      assert.equal((error as { phase?: string }).phase, CHAIN_PHASES.FORWARD);
      assert.equal((error as { cleanupFailed?: boolean }).cleanupFailed, true);
      return true;
    },
  );
});

void test('a failing lease release after a clean run reports the release phase', async () => {
  const database = createCollectorD1();
  const history = lifecycle();
  const { rpc } = fakeChainRpc(history, { [CHANNEL]: null });
  await runChainIndex(database, endpoints(rpc), 1000);
  const prepare = database.prepare.bind(database);
  let updates = 0;
  database.prepare = (sql) => {
    if (sql.startsWith('update') && sql.includes('lease_until')) {
      updates += 1;
      if (updates === 2) {
        const failing = {
          bind: () => failing,
          all: () => Promise.reject(new Error('D1 unavailable')),
          run: () => Promise.reject(new Error('D1 unavailable')),
        };
        return failing as ReturnType<typeof prepare>;
      }
    }
    return prepare(sql);
  };
  await assert.rejects(
    runChainIndex(database, endpoints(rpc), 2000),
    (error) => {
      assert.equal((error as { phase?: string }).phase, CHAIN_PHASES.RELEASE);
      assert.equal((error as { cleanupFailed?: boolean }).cleanupFailed, false);
      return true;
    },
  );
});

void test('a run that lost its lease mid-flight neither counts nor moves the cursor', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeChainRpc(plain(3, 'p'));
  const foreignLease = 2000;
  const takeover: ChainRpc = {
    ...rpc,
    signatures(address, range) {
      database.raw
        .prepare(
          'UPDATE collector_chain_cursor SET lease_until = ? WHERE id = ?',
        )
        .run(foreignLease, CHAIN_CURSOR_ID);
      return rpc.signatures(address, range);
    },
  };
  await runChainIndex(database, endpoints(takeover), 1000);
  assert.equal(counted(database), 0);
  assert.deepEqual(
    rows(database, 'SELECT newest_signature FROM collector_chain_cursor'),
    [{ newest_signature: null }],
  );
  await runChainIndex(database, endpoints(rpc), foreignLease + 1);
  assert.equal(counted(database), 3);
});

void test('a run reads the cursor after taking the lease, never a stale snapshot', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeChainRpc(plain(3, 'p'));
  database.raw.exec(
    'INSERT INTO collector_chain_cursor (id, gap_full, backfill_full, backfill_done, updated_at) VALUES (1, 0, 0, 0, 0)',
  );
  const day = new Date(BLOCK_TIME_S * 1000).toISOString().slice(0, 10);
  const prepare = database.prepare.bind(database);
  let seeded = false;
  database.prepare = (sql) => {
    if (!seeded && sql.startsWith('update') && sql.includes('lease_until')) {
      seeded = true;
      database.raw
        .prepare(
          'UPDATE collector_chain_cursor SET newest_signature = ?, backfill_before = ? WHERE id = ?',
        )
        .run('p3', 'p2', CHAIN_CURSOR_ID);
      database.raw
        .prepare(
          'INSERT INTO collector_chain_program_daily (day, transactions, failed, updated_at) VALUES (?, 2, 0, 0)',
        )
        .run(day);
    }
    return prepare(sql);
  };
  const run = await runChainIndex(database, endpoints(rpc), 1000);
  assert.equal(run.listed, 1);
  assert.equal(counted(database), 3);
});

void test('a run that lost its lease never moves a followed channel cursor', async () => {
  const database = createCollectorD1();
  database.raw.exec(
    `INSERT INTO collector_chain_channels (channel, gyblos, status, following, follow_until, last_signature, last_slot, updated_at)
       VALUES ('chan', 1, 'open', 1, 'sig-start', 'sig-start', 1, 0)`,
  );
  const history = plain(2, 'f');
  for (const entry of history) entry.addresses.push('chan');
  const { rpc } = fakeChainRpc(history);
  const takeover: ChainRpc = {
    ...rpc,
    signatures(address, range) {
      database.raw
        .prepare(
          'UPDATE collector_chain_cursor SET lease_until = ? WHERE id = ?',
        )
        .run(2000, CHAIN_CURSOR_ID);
      return rpc.signatures(address, range);
    },
  };
  await runChainIndex(database, endpoints(takeover), 1000);
  assert.deepEqual(
    rows(
      database,
      "SELECT follow_until FROM collector_chain_channels WHERE channel = 'chan'",
    ),
    [{ follow_until: 'sig-start' }],
  );
});

void test('a page spanning more days than one count statement holds stays countable', async () => {
  const database = createCollectorD1();
  const DAY_MS = 86_400_000;
  const base = Date.UTC(2026, 11, 28);
  const history = Array.from({ length: 27 }, (_, index) =>
    withSignature(`day${index}`, undefined, {
      blockTimeMs: base - index * DAY_MS,
    }),
  );
  const { rpc } = fakeChainRpc(history);
  await runChainIndex(database, endpoints(rpc), 1000);
  assert.equal(counted(database), 27);
});

void test('a run that lost its lease writes no transaction or channel rows', async () => {
  const database = createCollectorD1();
  const history = lifecycle();
  const { rpc } = fakeChainRpc(history, { [CHANNEL]: null });
  const takeover: ChainRpc = {
    ...rpc,
    signatures(address, range) {
      database.raw
        .prepare(
          'UPDATE collector_chain_cursor SET lease_until = ? WHERE id = ?',
        )
        .run(2000, CHAIN_CURSOR_ID);
      return rpc.signatures(address, range);
    },
  };
  await runChainIndex(database, endpoints(takeover), 1000);
  assert.deepEqual(
    rows(database, 'SELECT count(*) AS c FROM collector_chain_txs'),
    [{ c: 0 }],
  );
  assert.deepEqual(
    rows(database, 'SELECT count(*) AS c FROM collector_chain_channels'),
    [{ c: 0 }],
  );
  assert.deepEqual(
    rows(database, 'SELECT count(*) AS c FROM collector_chain_instructions'),
    [{ c: 0 }],
  );
  assert.deepEqual(
    rows(database, 'SELECT count(*) AS c FROM collector_chain_token_deltas'),
    [{ c: 0 }],
  );
  assert.deepEqual(
    rows(database, 'SELECT count(*) AS c FROM collector_agg_chain_dirty_days'),
    [{ c: 0 }],
  );
});
