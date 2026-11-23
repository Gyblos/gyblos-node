import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainTxsQuery,
  chainTxsUrl,
  parseChainTxs,
  txRow,
} from '@gyblos/explorer/chain-txs-shape';
import { CHAIN_TXS } from '@gyblos/explorer/constants';
import { CHAIN_TX_PAGE } from '@gyblos/metrics-collector/constants';
import { parseChainTxQuery } from '@gyblos/metrics-collector/stats-chain-txs';

const OWNER = 'CQ3znZDWsSH6unNaov2aizowCueQPFozRUyRrMuyuJde';
const CURSOR = `140-${'5'.repeat(87)}-1`;

void test('the explorer asks the collector for one seller owner with the canonical query', () => {
  assert.equal(CHAIN_TXS.recipientParam, CHAIN_TX_PAGE.params.RECIPIENT);
  for (const before of [null, CURSOR]) {
    const query = chainTxsQuery(before, OWNER);
    const parsed = parseChainTxQuery(new URLSearchParams(query));
    assert.deepEqual(parsed?.recipient, OWNER, query);
    assert.equal(new URLSearchParams(query).get('before'), before);
  }
  assert.equal(
    chainTxsUrl('https://c.test/v1', null, OWNER),
    `https://c.test/v1/stats/chain/txs?recipient=${OWNER}`,
  );
  assert.equal(
    chainTxsUrl('https://c.test/v1', null),
    'https://c.test/v1/stats/chain/txs',
  );
});

const payout = (extra: object) => ({
  programId: 'P',
  treasury: 'T',
  next: null,
  transactions: [
    {
      signature: '5'.repeat(87),
      instructionIndex: 1,
      slot: 140,
      blockTime: null,
      kind: 'distribute',
      channel: 'Channel1111',
      payee: null,
      recipients: [OWNER],
      amountAtomic: '96',
      ...extra,
    },
  ],
});
const split = (channels: number) => ({
  paidOut: '96',
  gyblosFees: '4',
  programTreasury: '0',
  refunded: '900',
  channels,
  unclassified: '0',
});

void test('a seller page payout row reads as what the seller got, with the rest of its split', () => {
  const owners = new Map();
  const row = txRow(
    parseChainTxs(payout({ split: split(1) })).transactions[0]!,
    owners,
    'T',
  );
  assert.deepEqual(
    [row.amount, row.detail, row.shared],
    ['0.000096', ['Gyblos fee 0.000004', 'to buyer 0.000900'], false],
  );
  const shared = txRow(
    parseChainTxs(payout({ split: split(2) })).transactions[0]!,
    owners,
    'T',
  );
  assert.equal(shared.detail[0], 'total of 2 channels');
  assert.equal(shared.shared, true);
  const legacy = txRow(parseChainTxs(payout({})).transactions[0]!, owners, 'T');
  assert.deepEqual([legacy.amount, legacy.detail], ['—', []]);
});
