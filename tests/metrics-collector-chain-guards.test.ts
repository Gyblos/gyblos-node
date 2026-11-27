import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeTransaction } from '@gyblos/metrics-collector/chain/decode';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import { createChainRpc } from '@gyblos/metrics-collector/chain/rpc';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

import {
  BLOCK_TIME_S,
  endpoints,
  fakeChainRpc,
  plainTx,
  PROGRAM,
  withSignature,
} from './support/metrics-collector-chain';
import {
  CHANNEL,
  lifecycle,
  rows,
} from './support/metrics-collector-chain-index';
import { createCollectorD1 } from './support/metrics-collector-d1';

const SHAPE = { name: 'ChainShapeError' };

const reply = (result: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
  );

const signatureList = (
  entries: { slot?: number; blockTime?: number | null }[],
) =>
  entries.map(({ slot = 1, blockTime = BLOCK_TIME_S }) => ({
    signature: 'a'.repeat(64),
    slot,
    blockTime,
    err: null,
    memo: null,
    confirmationStatus: 'finalized',
  }));

void test('a signature page with an out-of-range slot or block time is refused', async () => {
  const rpc = (entries: ReturnType<typeof signatureList>) =>
    createChainRpc('https://rpc.test', () => reply(entries));
  await assert.rejects(
    rpc(signatureList([{ slot: -1 }])).signatures(PROGRAM, {}),
    SHAPE,
  );
  await assert.rejects(
    rpc(signatureList([{ slot: CHAIN_INDEX.maxSlot + 1 }])).signatures(
      PROGRAM,
      {},
    ),
    SHAPE,
  );
  await assert.rejects(
    rpc(signatureList([{ blockTime: -1 }])).signatures(PROGRAM, {}),
    SHAPE,
  );
  await assert.rejects(
    rpc(
      signatureList([{ blockTime: CHAIN_INDEX.maxBlockTimeSec + 1 }]),
    ).signatures(PROGRAM, {}),
    SHAPE,
  );
  const accepted = await rpc(
    signatureList([{ slot: 42, blockTime: null }]),
  ).signatures(PROGRAM, {});
  assert.equal(accepted.length, 1);
});

void test('a transaction decode refuses an out-of-range slot or block time', () => {
  const tx = plainTx('b'.repeat(64), []);
  assert.throws(
    () =>
      decodeTransaction({
        ...(tx as object),
        slot: -1,
      }),
    SHAPE,
  );
  assert.throws(
    () =>
      decodeTransaction({
        ...(tx as object),
        blockTime: CHAIN_INDEX.maxBlockTimeSec + 1,
      }),
    SHAPE,
  );
});

void test('a forward page entry below the history floor is not counted as a fabricated day', async () => {
  const database = createCollectorD1();
  const history = lifecycle();
  const { rpc } = fakeChainRpc(history, { [CHANNEL]: null });
  await runChainIndex(database, endpoints(rpc), 1000);
  const before = rows(
    database,
    'SELECT day, transactions FROM collector_chain_program_daily',
  );
  history.unshift(
    withSignature('c'.repeat(64), plainTx('c'.repeat(64), []), {
      blockTimeMs: 1_000,
      slot: (history[0]?.listed.slot ?? 0) + 1,
    }),
  );
  await runChainIndex(database, endpoints(rpc), 2_000);
  const after = rows(
    database,
    'SELECT day, transactions FROM collector_chain_program_daily',
  );
  const fabricated = after.filter(
    (row) => !before.some((same) => same.day === row.day),
  );
  assert.equal(
    fabricated.every(
      (row) =>
        new Date(`${row.day}T00:00:00.000Z`).getTime() >=
        CHAIN_INDEX.historyFloorMs,
    ),
    true,
  );
});
