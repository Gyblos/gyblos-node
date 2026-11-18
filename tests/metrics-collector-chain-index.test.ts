// Protects the scheduled chain read (#349) and what it costs: the program's traffic is only counted
// from its signature list (a thousand per call), a transaction is read in full only when it opens a
// Gyblos channel or belongs to a followed one; an idle run costs one call; history stops at the floor;
// every signature counts exactly once across budgets, failures and lagging answers; a rate-limited
// free endpoint hands the run to the paid one, which is never used otherwise; a flooded channel is
// dropped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { base58Encode } from '@gyblos/metrics-collector/chain/base58';
import { decodeTransaction } from '@gyblos/metrics-collector/chain/decode';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

import {
  endpoints,
  fakeChainRpc,
  limitedAfter,
  PROGRAM,
  withSignature,
  type ChainEntry,
} from './support/metrics-collector-chain';
import {
  CHANNEL,
  counted,
  gyblosOpens,
  lifecycle,
  liveAccounts,
  OPEN,
  openAccount,
  plain,
  readCount,
  RECLAIM,
  rows,
  SETTLE,
} from './support/metrics-collector-chain-index';
import {
  createCollectorD1,
  type SqliteD1,
} from './support/metrics-collector-d1';

void test('a Gyblos channel is read in full from its open on, and an idle run costs one call', async () => {
  const database = createCollectorD1();
  const { rpc, calls } = fakeChainRpc(lifecycle(), { [CHANNEL]: null });
  const first = await runChainIndex(database, endpoints(rpc), 1000);
  assert.deepEqual(
    [first.listed, first.read, first.followed, first.backlog],
    [3, 3, 1, false],
  );
  // One program page, the open, the channel's page, its two later transactions, its account.
  assert.deepEqual(calls, { signatures: 2, transaction: 3, accounts: 1 });
  assert.equal(first.usage.primary.calls, 6);
  const [channel] = rows(
    database,
    'SELECT gyblos, status, following FROM collector_chain_channels',
  );
  // Reclaimed: closed, and no longer followed.
  assert.deepEqual(channel, { gyblos: 1, status: 'closed', following: 0 });
  assert.deepEqual(
    rows(
      database,
      'SELECT day, transactions, failed FROM collector_chain_program_daily',
    ),
    [{ day: '2026-11-02', transactions: 3, failed: 0 }],
  );
  assert.deepEqual(
    rows(
      database,
      "SELECT cumulative_atomic FROM collector_chain_instructions WHERE kind = 'settle_and_seal'",
    ),
    [{ cumulative_atomic: '145' }],
  );

  const idle = await runChainIndex(database, endpoints(rpc), 2000);
  assert.equal(idle.usage.primary.calls, 1);
  assert.equal(readCount(database), 3);
  assert.equal(counted(database), 3);
});

void test("other projects' traffic is counted from the list and never read", async () => {
  const database = createCollectorD1();
  const { rpc, calls } = fakeChainRpc(plain(2500, 'other'));
  const result = await runChainIndex(database, endpoints(rpc), 1000);
  assert.deepEqual(
    [result.listed, result.read, result.cursor.backfillDone],
    [2500, 0, true],
  );
  assert.deepEqual(calls, { signatures: 3, transaction: 0, accounts: 0 });
  assert.equal(counted(database), 2500);
  assert.equal(readCount(database), 0);
});

void test('history stops at the floor, and failed transactions are counted, never read', async () => {
  const database = createCollectorD1();
  const old = CHAIN_INDEX.historyFloorMs - 1;
  const [open] = gyblosOpens(1);
  const failedOpen = withSignature('failed-open', OPEN, { failed: true });
  const { rpc, calls } = fakeChainRpc([
    withSignature('new'),
    failedOpen,
    withSignature('old1', undefined, { blockTimeMs: old }),
    { ...open!, listed: { ...open!.listed, blockTimeMs: old } },
  ]);
  const result = await runChainIndex(database, endpoints(rpc), 1000);
  assert.deepEqual(
    [result.listed, result.read, result.cursor.backfillDone],
    [2, 0, true],
  );
  assert.equal(calls.transaction, 0);
  assert.deepEqual(
    rows(
      database,
      'SELECT sum(transactions) AS transactions, sum(failed) AS failed FROM collector_chain_program_daily',
    ),
    [{ transactions: 2, failed: 1 }],
  );
});

void test('a spent budget stops the read, which resumes and counts every signature once', async () => {
  const database = createCollectorD1();
  const opens = gyblosOpens(3);
  const history = [...opens, ...plain(5, 'p')];
  const { rpc } = fakeChainRpc(history, liveAccounts(opens));
  const runs: number[] = [];
  for (let run = 0; run < 6; run += 1) {
    // Three calls: the forward check, a history page, one read.
    const result = await runChainIndex(database, endpoints(rpc, 3), run);
    runs.push(result.usage.primary.calls);
  }
  assert.ok(runs.every((calls) => calls <= 3));
  assert.equal(readCount(database), 3);
  assert.equal(counted(database), 8);
  assert.equal(
    rows(database, 'SELECT * FROM collector_chain_channels WHERE following = 1')
      .length,
    3,
  );
});

void test('a rate-limited free endpoint hands the run to the paid one, used for nothing else', async () => {
  const healthy = fakeChainRpc(lifecycle(), { [CHANNEL]: null });
  const paid = fakeChainRpc(lifecycle(), { [CHANNEL]: null });
  const database = createCollectorD1();
  const result = await runChainIndex(
    database,
    endpoints(limitedAfter(healthy.rpc, 2), 1000, {
      rpc: paid.rpc,
      budget: 20,
    }),
    1000,
  );
  assert.deepEqual(result.usage.primary, { calls: 3, rateLimited: 1 });
  assert.equal(result.usage.onFallback, true);
  assert.equal(result.usage.fallback.calls, 4);
  assert.equal(readCount(database), 3);

  // A healthy free endpoint never touches the paid one.
  const unused = fakeChainRpc(lifecycle());
  await runChainIndex(
    createCollectorD1(),
    endpoints(healthy.rpc, 1000, { rpc: unused.rpc, budget: 20 }),
    1000,
  );
  assert.deepEqual(unused.calls, {
    signatures: 0,
    transaction: 0,
    accounts: 0,
  });
});

void test('a rate limit with no paid endpoint keeps what was read, and the next run finishes once', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeChainRpc(lifecycle(), { [CHANNEL]: null });
  await assert.rejects(
    runChainIndex(database, endpoints(limitedAfter(rpc, 2)), 1000),
    { name: 'ChainIndexError' },
  );
  // The program page and the open were stored before the limit.
  assert.equal(counted(database), 3);
  assert.equal(readCount(database), 1);
  await runChainIndex(database, endpoints(rpc), 2000);
  assert.equal(counted(database), 3);
  assert.equal(readCount(database), 3);
});

void test('a followed channel is polled at most once per follow interval', async () => {
  const database = createCollectorD1();
  const opens = gyblosOpens(1);
  const { rpc } = fakeChainRpc(opens, liveAccounts(opens));
  await runChainIndex(database, endpoints(rpc), 1000);
  // Ten minutes later: only the program's new signatures are checked.
  const soon = await runChainIndex(database, endpoints(rpc), 1000 + 600_000);
  assert.deepEqual([soon.followed, soon.usage.primary.calls], [0, 1]);
  const due = await runChainIndex(
    database,
    endpoints(rpc),
    1000 + CHAIN_INDEX.followIntervalMs,
  );
  // The channel's list, and its account (Gyblos channels' state is refreshed every interval).
  assert.deepEqual([due.followed, due.usage.primary.calls], [1, 3]);
});

void test('a followed channel that floods its list is dropped unread', async () => {
  const database = createCollectorD1();
  const [open] = gyblosOpens(1);
  const channel = open!.addresses[1]!;
  const history = [open!];
  const { rpc } = fakeChainRpc(history, liveAccounts(history));
  await runChainIndex(database, endpoints(rpc), 1000);
  history.unshift(
    ...Array.from({ length: CHAIN_INDEX.signaturesPerPage }, (_, index) =>
      withSignature(`spam${index}`, undefined, {
        // Newer than the open.
        slot: 1e12 - index,
        addresses: [PROGRAM, channel],
      }),
    ),
  );
  const result = await runChainIndex(
    database,
    endpoints(rpc),
    1000 + CHAIN_INDEX.followIntervalMs,
  );
  assert.deepEqual([result.flooded, result.read], [1, 0]);
  assert.deepEqual(
    rows(database, 'SELECT following FROM collector_chain_channels'),
    [{ following: 0 }],
  );
});

void test('a gap past a full page is closed only when the chain shows it empty', async () => {
  for (const pending of [CHAIN_INDEX.signaturesPerPage, 1500]) {
    const database = createCollectorD1();
    const history = plain(10, 'old');
    const { rpc } = fakeChainRpc(history);
    await runChainIndex(database, endpoints(rpc), 1000);
    history.unshift(...plain(pending, 'new'));
    await runChainIndex(database, endpoints(rpc), 2000);
    // A lagging backend that answers every list empty never closes the gap.
    const lagging = { ...rpc, signatures: () => Promise.resolve([]) };
    if (pending > CHAIN_INDEX.signaturesPerPage)
      await assert.rejects(runChainIndex(database, endpoints(lagging), 3000), {
        name: 'ChainIndexError',
      });
    for (let run = 0; run < 3; run += 1)
      await runChainIndex(database, endpoints(rpc), 4000 + run);
    assert.equal(counted(database), 10 + pending);
  }
});
