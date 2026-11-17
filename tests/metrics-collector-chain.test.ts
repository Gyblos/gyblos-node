// Protects the chain index (#349): real devnet transactions decode exactly (versions 0 and 1); vouchers
// count only when adjacent and for their own channel; failed or unreadable transactions never stop the
// index; channel accounts are owner-checked; the scheduled read stores every signature exactly once
// across forward reads, gaps and history, within its budget and D1's parameter limit, and a failed
// read resumes where it stopped.
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
import { chainRpcUrl } from '@gyblos/metrics-collector/chain/rpc';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

import {
  fakeChainRpc,
  plainTx,
  PROGRAM,
  withSignature,
} from './support/metrics-collector-chain';
import { createCollectorD1 } from './support/metrics-collector-d1';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/chain/devnet-${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
const OPEN = fixture('open');
const SETTLE = fixture('seal-distribute');
const RECLAIM = fixture('reclaim');
const CHANNEL = 'EVQfRwtXxHj13yGVrbU8DnPLbvC1pNe2qxpMMZ3pR3jN';
const PAYER = 'DrmfjFNWzLDqDqUmxuFYWrfer2q2em89UpnLxqojnE9o';
const rowsOf = (
  database: ReturnType<typeof createCollectorD1>,
  query: string,
) => database.rows(query).map((row) => ({ ...row }));
const signatureOf = (tx: unknown) => decodeTransaction(tx).signature;
const lifecycle = () =>
  [RECLAIM, SETTLE, OPEN].map((tx) => ({ signature: signatureOf(tx), tx }));

void test('real devnet transactions decode to the channel lifecycle', () => {
  const [open] = decodeTransaction(OPEN).instructions;
  assert.deepEqual(
    [open!.kind, open!.channel, open!.payer, open!.amountAtomic, open!.salt],
    ['open', CHANNEL, PAYER, 10_000n, '3025764848692434101'],
  );
  assert.deepEqual(open!.recipients, [
    { owner: 'BJxYKSkMQmySQNNDSWcYNFdYWecGJpj7qnhtGc87Rga5', bps: 9709 },
    { owner: '4Ui1dfvqbFx9CtjXNcKajHdr7aKT1nbYRiYjB1s7umNy', bps: 291 },
  ]);
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
  const v1 = decodeTransaction(fixture('v1-settle'));
  assert.deepEqual(
    v1.instructions.map((entry) => entry.kind),
    ['settle_and_seal', 'distribute'],
  );
});

void test('a voucher counts only when adjacent, for its channel, and when the seal carries one', () => {
  const data = new Uint8Array(16 + 50);
  new DataView(data.buffer).setUint16(10, 16, true);
  data.set([86, 1], 16);
  data.set(base58Decode(CHANNEL), 18);
  new DataView(data.buffer).setBigUint64(16 + 34, 777n, true);
  assert.deepEqual(voucherOf(data), {
    channel: CHANNEL,
    cumulativeAtomic: 777n,
  });
  const ed25519 = {
    programId: 'Ed25519SigVerify111111111111111111111111111',
    data: base58Encode(data),
    accounts: [],
  };
  const settle = {
    programId: PROGRAM,
    data: base58Encode(Uint8Array.from([2])),
    accounts: [CHANNEL, 'Sysvar'],
  };
  const memo = {
    programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    parsed: 'x',
  };
  const seal = (hasVoucher: number) => ({
    programId: PROGRAM,
    data: base58Encode(Uint8Array.from([4, hasVoucher])),
    accounts: ['Payee', CHANNEL, 'Sysvar'],
  });
  const cumulative = (instructions: unknown[]) =>
    decodeTransaction(plainTx('sig', instructions)).instructions.map(
      (entry) => entry.cumulativeAtomic,
    );
  assert.deepEqual(cumulative([ed25519, settle]), [777n]);
  assert.deepEqual(cumulative([ed25519, memo, settle]), [null]);
  assert.deepEqual(cumulative([ed25519, seal(1)]), [777n]);
  assert.deepEqual(cumulative([ed25519, seal(0)]), [null]);
  assert.equal(base58Encode(base58Decode(CHANNEL)), CHANNEL);
  assert.deepEqual(base58Decode('11'), Uint8Array.from([0, 0]));
  assert.throws(() => base58Decode('0OIl'), { name: 'Base58Error' });
});

void test('failed or unreadable program instructions never stop decoding', () => {
  const garbage = {
    programId: PROGRAM,
    data: base58Encode(Uint8Array.from([1])),
    accounts: [],
  };
  const failed = decodeTransaction(
    plainTx('failed', [garbage], { err: 'boom' }),
  );
  assert.deepEqual(
    [failed.failed, failed.instructions.length, failed.undecodable],
    [true, 0, 0],
  );
  const unreadable = decodeTransaction(plainTx('ok', [garbage]));
  assert.deepEqual(
    [unreadable.failed, unreadable.instructions.length, unreadable.undecodable],
    [false, 0, 1],
  );
});

void test('a channel account is read only when the program owns it', () => {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  bytes[3] = 1;
  view.setBigUint64(12, 10_000n, true);
  view.setBigUint64(20, 145n, true);
  view.setBigUint64(28, 100n, true);
  const data = btoa(String.fromCharCode(...bytes));
  assert.deepEqual(channelState({ owner: PROGRAM, data }), {
    status: 'sealed',
    depositAtomic: 10_000n,
    settledAtomic: 145n,
    payoutAtomic: 100n,
  });
  assert.equal(channelState({ owner: 'Other', data }).status, 'unknown');
  assert.equal(
    channelState({ owner: PROGRAM, data: btoa('short') }).status,
    'unknown',
  );
  assert.equal(channelState(null).status, 'closed');
});

void test('only an https (or loopback http) RPC URL without credentials is used', () => {
  assert.equal(chainRpcUrl('https://rpc.example/'), 'https://rpc.example/');
  assert.equal(chainRpcUrl('http://127.0.0.1:8899'), 'http://127.0.0.1:8899/');
  for (const bad of [
    'http://rpc.example',
    'https://u:p@rpc.example',
    'https://rpc.example/?key=1',
    'nope',
    42,
  ])
    assert.equal(chainRpcUrl(bad), undefined, String(bad));
});

void test('the scheduled read stores the lifecycle once and mirrors the channel', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeChainRpc(lifecycle(), { [CHANNEL]: null });
  const first = await runChainIndex(database, rpc, 1000);
  assert.deepEqual(
    [
      first.gap,
      first.forward,
      first.backfill,
      first.channels,
      first.cursor.backfillDone,
    ],
    [0, 0, 3, 1, true],
  );
  const [channel] = rowsOf(database, 'SELECT * FROM collector_chain_channels');
  assert.deepEqual(
    [channel!.payer, channel!.gyblos, channel!.status, channel!.last_signature],
    [PAYER, 1, 'closed', signatureOf(RECLAIM)],
  );
  assert.deepEqual(
    rowsOf(
      database,
      "SELECT cumulative_atomic FROM collector_chain_instructions WHERE kind = 'settle_and_seal'",
    ),
    [{ cumulative_atomic: '145' }],
  );
  const again = await runChainIndex(database, rpc, 2000);
  assert.deepEqual([again.forward, again.backfill], [0, 0]);
  assert.equal(rowsOf(database, 'SELECT * FROM collector_chain_txs').length, 3);
});

void test('new signatures are read forward, and a backlog over the budget becomes a gap filled next run', async () => {
  const database = createCollectorD1();
  const history = Array.from({ length: 5 }, (_, index) =>
    withSignature(`old${index}`),
  );
  const { rpc } = fakeChainRpc(history);
  await runChainIndex(database, rpc, 1000);
  const backlog = CHAIN_INDEX.maxTransactionsPerRun + 50;
  history.unshift(
    ...Array.from({ length: backlog }, (_, index) =>
      withSignature(`new${backlog - index}`),
    ),
  );
  const first = await runChainIndex(database, rpc, 2000);
  assert.deepEqual(
    [first.forward, first.cursor.newest, first.cursor.gapUntil],
    [CHAIN_INDEX.maxTransactionsPerRun, `new${backlog}`, 'old0'],
  );
  const second = await runChainIndex(database, rpc, 3000);
  assert.deepEqual(
    [second.gap, second.forward, second.cursor.gapUntil],
    [50, 0, null],
  );
  assert.equal(
    rowsOf(database, 'SELECT * FROM collector_chain_txs').length,
    5 + backlog,
  );
});

void test('history over the budget resumes, and an empty program starts once it has transactions', async () => {
  const database = createCollectorD1();
  const history: ReturnType<typeof withSignature>[] = [];
  const { rpc } = fakeChainRpc(history);
  const empty = await runChainIndex(database, rpc, 1000);
  assert.deepEqual(
    [empty.cursor.newest, empty.cursor.backfillDone],
    [null, false],
  );
  const total = CHAIN_INDEX.maxTransactionsPerRun + 10;
  history.push(
    ...Array.from({ length: total }, (_, index) =>
      withSignature(`sig${total - index}`),
    ),
  );
  const first = await runChainIndex(database, rpc, 2000);
  assert.deepEqual(
    [first.backfill, first.cursor.backfillDone],
    [CHAIN_INDEX.maxTransactionsPerRun, false],
  );
  const second = await runChainIndex(database, rpc, 3000);
  assert.deepEqual([second.backfill, second.cursor.backfillDone], [10, true]);
  assert.equal(
    rowsOf(database, 'SELECT * FROM collector_chain_txs').length,
    total,
  );
});

void test('a failed read stores nothing past it and resumes on the next run', async () => {
  const database = createCollectorD1();
  const { rpc } = fakeChainRpc(lifecycle());
  const failing = {
    ...rpc,
    transactions: () => Promise.reject(new Error('rate limited')),
  };
  await assert.rejects(runChainIndex(database, failing, 1000), {
    name: 'ChainIndexError',
  });
  assert.equal(rowsOf(database, 'SELECT * FROM collector_chain_txs').length, 0);
  assert.equal((await runChainIndex(database, rpc, 2000)).backfill, 3);
});

void test('a batch of many opens stays under the parameter limit, and failed transactions name no channel', async () => {
  const database = createCollectorD1();
  type Message = { instructions: { accounts?: string[] }[] };
  const opens = Array.from(
    { length: CHAIN_INDEX.transactionsPerRequest },
    (_, index) => {
      const tx = structuredClone(OPEN) as { transaction: { message: Message } };
      const program = tx.transaction.message.instructions.find(
        (entry) => entry.accounts?.length === 14,
      )!;
      program.accounts![5] = base58Encode(
        Uint8Array.from({ length: 32 }, () => index + 1),
      );
      return withSignature(`open${index}`, tx);
    },
  );
  const failed = structuredClone(SETTLE) as { meta: Record<string, unknown> };
  failed.meta.err = 'boom';
  const { rpc } = fakeChainRpc([withSignature('failed', failed), ...opens]);
  const result = await runChainIndex(database, rpc, 1000);
  assert.equal(result.backfill, opens.length + 1);
  assert.equal(
    rowsOf(database, 'SELECT * FROM collector_chain_channels').length,
    opens.length,
  );
  assert.deepEqual(
    rowsOf(
      database,
      "SELECT failed FROM collector_chain_txs WHERE signature = 'failed'",
    ),
    [{ failed: 1 }],
  );
});

void test('an empty answer from a lagging RPC never closes a gap known to hold signatures', async () => {
  const database = createCollectorD1();
  const history = Array.from({ length: 10 }, (_, index) =>
    withSignature(`old${index}`),
  );
  const { rpc } = fakeChainRpc(history);
  await runChainIndex(database, rpc, 1000);
  const backlog = 500;
  history.unshift(
    ...Array.from({ length: backlog }, (_, index) =>
      withSignature(`new${backlog - index}`),
    ),
  );
  await runChainIndex(database, rpc, 2000);
  // The backend cannot find gapBefore yet and answers an empty page.
  const lagging = { ...rpc, signatures: () => Promise.resolve([]) };
  await assert.rejects(runChainIndex(database, lagging, 3000), {
    name: 'ChainIndexError',
  });
  for (let run = 0; run < 3; run++)
    await runChainIndex(database, rpc, 4000 + run);
  assert.equal(
    rowsOf(database, 'SELECT * FROM collector_chain_txs').length,
    10 + backlog,
  );
});

void test('a lagging RPC never ends a gap or the history cut by the budget, even past a full page', async () => {
  const pending = 1500;
  const lagging = (rpc: ReturnType<typeof fakeChainRpc>['rpc']) => ({
    ...rpc,
    signatures: () => Promise.resolve([]),
  });
  // Gap: 10 old signatures, then more new ones than one page.
  const gapDatabase = createCollectorD1();
  const gapHistory = Array.from({ length: 10 }, (_, index) =>
    withSignature(`old${index}`),
  );
  const gap = fakeChainRpc(gapHistory);
  await runChainIndex(gapDatabase, gap.rpc, 1000);
  gapHistory.unshift(
    ...Array.from({ length: pending }, (_, index) =>
      withSignature(`new${pending - index}`),
    ),
  );
  await runChainIndex(gapDatabase, gap.rpc, 2000);
  await assert.rejects(runChainIndex(gapDatabase, lagging(gap.rpc), 3000));
  // History: more than one page, cut by the budget.
  const historyDatabase = createCollectorD1();
  const history = fakeChainRpc(
    Array.from({ length: pending }, (_, index) =>
      withSignature(`h${pending - index}`),
    ),
  );
  await runChainIndex(historyDatabase, history.rpc, 1000);
  await assert.rejects(
    runChainIndex(historyDatabase, lagging(history.rpc), 2000),
  );
  const runs = Math.ceil(pending / CHAIN_INDEX.maxTransactionsPerRun) + 1;
  for (let run = 0; run < runs; run++) {
    await runChainIndex(gapDatabase, gap.rpc, 4000 + run);
    await runChainIndex(historyDatabase, history.rpc, 4000 + run);
  }
  assert.equal(
    rowsOf(gapDatabase, 'SELECT * FROM collector_chain_txs').length,
    10 + pending,
  );
  assert.equal(
    rowsOf(historyDatabase, 'SELECT * FROM collector_chain_txs').length,
    pending,
  );
});
