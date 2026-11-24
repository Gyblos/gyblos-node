import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainTxsQuery,
  chainTxsUrl,
  parseChainTxs,
  txRow,
} from '@gyblos/explorer/chain-txs-shape';
import { CHAIN_TXS, TX_TEXT } from '@gyblos/explorer/constants';
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
    `https://c.test/v1/stats/chain/txs?limit=5&recipient=${OWNER}`,
  );
  assert.equal(
    chainTxsUrl('https://c.test/v1', null),
    'https://c.test/v1/stats/chain/txs?limit=5',
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
    [row.amount, row.parts, row.shared],
    [
      '0.000096',
      { gyblosFees: '0.000004', programTreasury: null, refunded: '0.000900' },
      false,
    ],
  );
  const shared = txRow(
    parseChainTxs(payout({ split: split(2) })).transactions[0]!,
    owners,
    'T',
  );
  assert.equal(shared.detail[0], 'total of 2 channels');
  assert.deepEqual(
    [shared.shared, shared.amount, shared.muted],
    [true, 'batch total 0.000096', true],
  );
  assert.equal(row.muted, false);
  const legacy = txRow(parseChainTxs(payout({})).transactions[0]!, owners, 'T');
  assert.deepEqual([legacy.amount, legacy.detail], ['—', []]);
});

void test('a batched paying row says so instead of showing no amount', () => {
  const row = txRow(
    parseChainTxs(payout({ amountAtomic: null, split: null, batched: true }))
      .transactions[0]!,
    new Map(),
    'T',
  );
  assert.deepEqual(
    [row.amount, row.muted, row.detail],
    ['—', true, [TX_TEXT.batched]],
  );
  assert.equal(
    parseChainTxs(payout({ split: split(1) })).transactions[0]!.batched,
    false,
  );
});

void test('only a payout is money; deposits and refunds are muted and named by their type', () => {
  const row = (kind: string, amountAtomic: string) =>
    txRow(
      parseChainTxs(
        payout({
          kind,
          amountAtomic,
          split: kind === 'reclaim' ? { ...split(1), paidOut: '0' } : null,
        }),
      ).transactions[0]!,
      new Map(),
      'T',
    );
  assert.deepEqual(
    ['open', 'top_up', 'reclaim', 'settle'].map((kind) => {
      const shown = row(kind, '900');
      return [kind, shown.muted, shown.label];
    }),
    [
      ['open', true, 'Deposit'],
      ['top_up', true, 'Top-up'],
      ['reclaim', true, 'Refunded'],
      ['settle', true, 'Settle'],
    ],
  );
});
