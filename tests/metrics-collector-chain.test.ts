// Protects the chain index (#349): real devnet open, settle-and-distribute and reclaim transactions are
// decoded exactly; vouchers only count for their own channel; channel accounts are read at their
// offsets; the scheduled read stores each transaction once, moves its cursors only with stored work,
// stays within its per-run budget, marks Gyblos channels and mirrors the account state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  base58Decode,
  base58Encode,
} from '@gyblos/metrics-collector/chain/base58';
import { channelState } from '@gyblos/metrics-collector/chain/channel-account';
import {
  decodeTransaction,
  voucherOf,
} from '@gyblos/metrics-collector/chain/decode';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import type { ChainRpc } from '@gyblos/metrics-collector/chain/rpc';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

import { createCollectorD1 } from './support/metrics-collector-d1';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/chain/devnet-${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const OPEN = fixture('open');
const SETTLE = fixture('seal-distribute');
const RECLAIM = fixture('reclaim');
const CHANNEL = 'EVQfRwtXxHj13yGVrbU8DnPLbvC1pNe2qxpMMZ3pR3jN';
const PAYER = 'DrmfjFNWzLDqDqUmxuFYWrfer2q2em89UpnLxqojnE9o';
const rowsOf = (
  database: ReturnType<typeof createCollectorD1>,
  query: string,
) => database.rows(query).map((row) => ({ ...row }));

void test('real devnet transactions decode to the channel lifecycle', () => {
  const open = decodeTransaction(OPEN);
  const [instruction] = open.instructions;
  assert.deepEqual(
    [
      instruction!.kind,
      instruction!.channel,
      instruction!.payer,
      instruction!.amountAtomic,
    ],
    ['open', CHANNEL, PAYER, 10_000n],
  );
  assert.equal(instruction!.salt, '3025764848692434101');
  assert.deepEqual(instruction!.recipients, [
    { owner: 'BJxYKSkMQmySQNNDSWcYNFdYWecGJpj7qnhtGc87Rga5', bps: 9709 },
    { owner: '4Ui1dfvqbFx9CtjXNcKajHdr7aKT1nbYRiYjB1s7umNy', bps: 291 },
  ]);
  assert.ok(open.memos[0]!.startsWith('gyblos:'));

  const settle = decodeTransaction(SETTLE);
  assert.deepEqual(
    settle.instructions.map((entry) => [entry.kind, entry.cumulativeAtomic]),
    [
      ['settle_and_seal', 145n],
      ['distribute', null],
    ],
  );
  // What distribute actually moved: the settled 145 to the program treasury, the rest refunded.
  assert.deepEqual(
    settle.deltas.map((delta) => [delta.owner.slice(0, 4), delta.deltaAtomic]),
    [
      ['4zTe', 145n],
      ['Drmf', 9855n],
      ['EVQf', -10_000n],
    ],
  );
  assert.deepEqual(
    decodeTransaction(RECLAIM).instructions.map((entry) => entry.kind),
    ['reclaim'],
  );
});

void test('a version 1 transaction decodes like a version 0 one', () => {
  const tx = decodeTransaction(fixture('v1-settle'));
  assert.deepEqual(
    tx.instructions.map((entry) => entry.kind),
    ['settle_and_seal', 'distribute'],
  );
  assert.ok((tx.instructions[0]!.cumulativeAtomic ?? 0n) > 0n);
});

void test('a voucher counts only for its own channel, and base58 round-trips', () => {
  const data = new Uint8Array(16 + 50);
  new DataView(data.buffer).setUint16(10, 16, true);
  data.set([86, 1], 16);
  data.set(base58Decode(CHANNEL), 18);
  new DataView(data.buffer).setBigUint64(16 + 34, 777n, true);
  assert.deepEqual(voucherOf(data), {
    channel: CHANNEL,
    cumulativeAtomic: 777n,
  });
  data[16] = 0;
  assert.equal(voucherOf(data), null);
  assert.equal(base58Encode(base58Decode(CHANNEL)), CHANNEL);
  assert.deepEqual(base58Decode('11'), Uint8Array.from([0, 0]));
  assert.throws(() => base58Decode('0OIl'), { name: 'Base58Error' });
});

void test('a channel account is read at its offsets, and a missing one is closed', () => {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  bytes[3] = 1;
  view.setBigUint64(12, 10_000n, true);
  view.setBigUint64(20, 145n, true);
  view.setBigUint64(28, 100n, true);
  const base64 = btoa(String.fromCharCode(...bytes));
  assert.deepEqual(channelState(base64), {
    status: 'sealed',
    depositAtomic: 10_000n,
    settledAtomic: 145n,
    payoutAtomic: 100n,
  });
  assert.equal(channelState(null).status, 'closed');
  assert.throws(() => channelState(btoa('short')), { name: 'ChainShapeError' });
});

// A program history, newest first, served like getSignaturesForAddress.
function fakeRpc(
  history: { signature: string; tx: unknown }[],
  accounts: Record<string, string | null> = {},
) {
  const calls = { transactions: 0 };
  const position = (signature: string | undefined) =>
    signature === undefined
      ? -1
      : history.findIndex((entry) => entry.signature === signature);
  const rpc: ChainRpc = {
    signatures({ until, before }) {
      const start = before ? position(before) + 1 : 0;
      const end = until ? position(until) : history.length;
      return Promise.resolve(
        history
          .slice(start, end)
          .slice(0, CHAIN_INDEX.signaturesPerPage)
          .map(({ signature }) => ({ signature })),
      );
    },
    transactions(signatures) {
      calls.transactions += 1;
      return Promise.resolve(
        signatures.map(
          (signature) =>
            history.find((entry) => entry.signature === signature)?.tx ?? null,
        ),
      );
    },
    accounts: (addresses) =>
      Promise.resolve(addresses.map((address) => accounts[address] ?? null)),
  };
  return { rpc, calls, history };
}
const signatureOf = (tx: unknown) => decodeTransaction(tx).signature;
const lifecycle = () =>
  [RECLAIM, SETTLE, OPEN].map((tx) => ({ signature: signatureOf(tx), tx }));

void test('the scheduled read stores the lifecycle once and mirrors the channel', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeRpc(lifecycle());
  const first = await runChainIndex(database, rpc, 1000);
  assert.deepEqual(first, {
    forward: 0,
    backfill: 3,
    channels: 1,
    backfillDone: true,
  });
  const [channel] = rowsOf(database, 'SELECT * FROM collector_chain_channels');
  assert.equal(channel!.payer, PAYER);
  assert.equal(channel!.gyblos, 1);
  assert.equal(channel!.status, 'closed');
  assert.equal(channel!.last_signature, signatureOf(RECLAIM));
  assert.equal(
    rowsOf(database, 'SELECT * FROM collector_chain_instructions').length,
    4,
  );
  const cumulative = rowsOf(
    database,
    "SELECT cumulative_atomic FROM collector_chain_instructions WHERE kind = 'settle_and_seal'",
  );
  assert.deepEqual(cumulative, [{ cumulative_atomic: 145 }]);

  // Nothing new: nothing read again, nothing stored twice.
  const again = await runChainIndex(database, rpc, 2000);
  assert.deepEqual([again.forward, again.backfill], [0, 0]);
  assert.equal(rowsOf(database, 'SELECT * FROM collector_chain_txs').length, 3);
});

void test('new signatures are read forward from the newest one already read', async () => {
  const database = createCollectorD1();
  const [reclaim, settle, open] = lifecycle();
  const history = [settle!, open!];
  const { rpc } = fakeRpc(history);
  await runChainIndex(database, rpc, 1000);
  history.unshift(reclaim!);
  const next = await runChainIndex(database, rpc, 2000);
  assert.deepEqual([next.forward, next.backfill], [1, 0]);
  const [cursor] = rowsOf(
    database,
    'SELECT newest_signature FROM collector_chain_cursor',
  );
  assert.equal(cursor!.newest_signature, reclaim!.signature);
});

void test('a run stays within its budget and the backfill resumes where it stopped', async () => {
  const database = createCollectorD1();
  const total = CHAIN_INDEX.maxTransactionsPerRun + 10;
  const history = Array.from({ length: total }, (_, index) => ({
    signature: `sig${index}`,
    tx: null,
  }));
  const { rpc } = fakeRpc(history);
  const first = await runChainIndex(database, rpc, 1000);
  assert.deepEqual(
    [first.backfill, first.backfillDone],
    [CHAIN_INDEX.maxTransactionsPerRun, false],
  );
  const second = await runChainIndex(database, rpc, 2000);
  assert.deepEqual([second.backfill, second.backfillDone], [10, true]);
});

void test('a failed read stores nothing and leaves the cursor for the next run', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeRpc(lifecycle());
  const failing: ChainRpc = {
    ...rpc,
    transactions: () => Promise.reject(new Error('rate limited')),
  };
  await assert.rejects(runChainIndex(database, failing, 1000));
  assert.equal(rowsOf(database, 'SELECT * FROM collector_chain_txs').length, 0);
  assert.equal(
    rowsOf(database, 'SELECT * FROM collector_chain_cursor').length,
    0,
  );
  const retried = await runChainIndex(database, rpc, 2000);
  assert.equal(retried.backfill, 3);
});
