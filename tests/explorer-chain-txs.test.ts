import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAIN_TX_KINDS,
  parseChainTxs,
  sellerOwners,
  txCursor,
  txPageHref,
  txRow,
} from '@gyblos/explorer/chain-txs-shape';
import { CHAIN_TXS, RANGE } from '@gyblos/explorer/constants';
import {
  CHAIN_INSTRUCTIONS,
  CHAIN_TX_PAGE,
} from '@gyblos/metrics-collector/constants';

const SIGNATURE =
  '5'.repeat(30) + 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CURSOR = `140-${SIGNATURE}-1`;
const SELLER = { nodeId: 'a'.repeat(64), owner: 'SellerOwner' };

function answer() {
  return {
    network: 'solana:devnet',
    programId: 'Program1111',
    mint: 'Mint1111',
    transactions: [
      {
        signature: SIGNATURE,
        instructionIndex: 1,
        slot: 140,
        blockTime: Date.UTC(2026, 10, 20, 14, 2, 30),
        kind: 'distribute',
        channel: 'ChannelAddress1111',
        payee: 'FeePayer1111',
        recipients: ['SellerOwner', 'Treasury1111'],
        amountAtomic: '1500000',
      },
      {
        signature: SIGNATURE,
        instructionIndex: 0,
        slot: 140,
        blockTime: null,
        kind: 'seal',
        channel: 'ChannelAddress1111',
        payee: null,
        recipients: [],
        amountAtomic: null,
      },
    ],
    next: CURSOR,
  };
}

void test('the explorer knows exactly the collector instruction kinds and page bounds', () => {
  assert.deepEqual([...CHAIN_TX_KINDS], Object.values(CHAIN_INSTRUCTIONS));
  assert.ok(CHAIN_TXS.pageSize <= CHAIN_TX_PAGE.maxLimit);
});

void test('channel transactions are checked at the boundary and amounts stay exact', () => {
  const page = parseChainTxs(answer());
  assert.equal(page.programId, 'Program1111');
  assert.equal(page.next, CURSOR);
  assert.deepEqual(page.transactions[0], {
    signature: SIGNATURE,
    instructionIndex: 1,
    slot: 140,
    blockTime: Date.UTC(2026, 10, 20, 14, 2, 30),
    kind: 'distribute',
    channel: 'ChannelAddress1111',
    payee: 'FeePayer1111',
    recipients: ['SellerOwner', 'Treasury1111'],
    amount: 1_500_000n,
  });
  assert.equal(page.transactions[1]!.amount, null);
  const broken = (edit: (body: ReturnType<typeof answer>) => void) => {
    const body = answer();
    edit(body);
    return () => parseChainTxs(body);
  };
  for (const edit of [
    (body: ReturnType<typeof answer>) => {
      body.transactions[0]!.kind = 'transfer';
    },
    (body: ReturnType<typeof answer>) => {
      body.transactions[0]!.amountAtomic = '1.5';
    },
    (body: ReturnType<typeof answer>) => {
      Reflect.deleteProperty(body.transactions[0]!, 'signature');
    },
    (body: ReturnType<typeof answer>) => {
      Reflect.set(body.transactions[0]!, 'recipients', 'SellerOwner');
    },
    (body: ReturnType<typeof answer>) => {
      Reflect.set(body.transactions[0]!, 'slot', '140');
    },
    (body: ReturnType<typeof answer>) => {
      body.next = 'not a cursor';
    },
    (body: ReturnType<typeof answer>) => {
      Reflect.deleteProperty(body, 'transactions');
    },
  ])
    assert.throws(broken(edit), /unexpected source shape/);
  assert.equal(parseChainTxs({ ...answer(), next: null }).next, null);
});

void test('only a well-formed single cursor is passed on to the collector', () => {
  assert.equal(txCursor(CURSOR), CURSOR);
  for (const value of [
    undefined,
    '',
    [CURSOR, CURSOR],
    `${CURSOR}&limit=50`,
    `140-${SIGNATURE}`,
    `1234567890123456-${SIGNATURE}-0`,
  ])
    assert.equal(txCursor(value), null);
});

void test('a row names the seller whose listed owner is paid by the channel, or none', () => {
  const owners = sellerOwners([SELLER]);
  const [distribute, seal] = parseChainTxs(answer()).transactions;
  const row = txRow(distribute!, owners);
  assert.deepEqual(row, {
    key: `${SIGNATURE}:1`,
    time: '2026-11-20 14:02',
    kind: 'distribute',
    channel: 'ChannelAddress1111',
    seller: SELLER.nodeId,
    payee: 'FeePayer1111',
    amount: '$1.5',
    signature: `${SIGNATURE.slice(0, 6)}…${SIGNATURE.slice(-6)}`,
    href: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
  });
  const unmatched = txRow(seal!, owners);
  assert.deepEqual(
    [unmatched.seller, unmatched.time, unmatched.amount],
    [null, '—', '—'],
  );
  const byPayee = txRow(
    { ...distribute!, recipients: [], payee: SELLER.owner },
    owners,
  );
  assert.equal(byPayee.seller, SELLER.nodeId);
  assert.equal(txRow(distribute!, sellerOwners([])).seller, null);
});

void test('pager links keep the range and carry the cursor', () => {
  assert.equal(txPageHref(RANGE.defaultDays, null), '/');
  assert.equal(txPageHref(RANGE.defaultDays, CURSOR), `/?before=${CURSOR}`);
  assert.equal(txPageHref(7, CURSOR), `/?range=7&before=${CURSOR}`);
  assert.equal(txPageHref(90, null), '/?range=90');
});
