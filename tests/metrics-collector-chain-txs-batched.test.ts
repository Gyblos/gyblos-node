import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_GYBLOS_TREASURY, DEVNET_USDC } from '@gyblos/config/network';
import { base58Encode } from '@gyblos/metrics-collector/chain/base58';
import { CHAIN_INSTRUCTIONS as K } from '@gyblos/metrics-collector/constants';

import {
  channel,
  delta,
  instruction,
  tx,
} from './support/metrics-collector-chain-rows';
import { collector, get, sig } from './support/metrics-collector-chain-txs';
import { createCollectorD1 } from './support/metrics-collector-d1';

const owner = (fill: number) => base58Encode(new Uint8Array(32).fill(fill));
const FIRST = owner(3);
const SECOND = owner(5);

function batched() {
  const database = createCollectorD1();
  for (const [address, seller] of [
    ['A', FIRST],
    ['B', SECOND],
  ] as const) {
    channel(database, address, { mint: DEVNET_USDC });
    database.raw
      .prepare(
        'UPDATE collector_chain_channels SET recipients_json = ? WHERE channel = ?',
      )
      .run(
        JSON.stringify([
          { owner: seller, bps: 9600 },
          { owner: DEVNET_GYBLOS_TREASURY, bps: 400 },
        ]),
        address,
      );
  }
  tx(database, sig('Open'), 1000, 1, { slot: 5 });
  instruction(database, sig('Open'), 0, K.OPEN, 'B', { amount: '50' });
  tx(database, sig('Pay'), 2000, 1, { slot: 10 });
  instruction(database, sig('Pay'), 0, K.DISTRIBUTE, 'A');
  instruction(database, sig('Pay'), 1, K.DISTRIBUTE, 'B');
  delta(database, sig('Pay'), 'A', '-50');
  delta(database, sig('Pay'), 'B', '-50');
  delta(database, sig('Pay'), FIRST, '48');
  delta(database, sig('Pay'), SECOND, '48');
  delta(database, sig('Pay'), DEVNET_GYBLOS_TREASURY, '4');
  return database;
}

void test('a paying row after the transaction first one is marked batched, never given an amount', async () => {
  const { app } = collector(batched());
  const rows = (await get(app)).body.transactions;
  assert.deepEqual(
    rows.map((row) => [
      row.channel,
      row.kind,
      row.batched,
      row.amountAtomic !== null,
    ]),
    [
      ['B', K.DISTRIBUTE, true, false],
      ['A', K.DISTRIBUTE, false, true],
      ['B', K.OPEN, false, true],
    ],
  );
  const second = (await get(app, `?recipient=${SECOND}`)).body.transactions;
  assert.deepEqual(
    second.map((row) => [row.kind, row.batched, row.split]),
    [
      [K.DISTRIBUTE, true, null],
      [K.OPEN, false, null],
    ],
  );
});
