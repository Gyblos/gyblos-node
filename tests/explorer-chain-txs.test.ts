import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAIN_TX_KINDS,
  CHAIN_TX_LABELS,
  chainTxsQuery,
  parseChainTxs,
  sellerOwners,
  txCursor,
  txPageHref,
  txRow,
  type ChainTx,
} from '@gyblos/explorer/chain-txs-shape';
import { CHAIN_TXS, RANGE } from '@gyblos/explorer/constants';
import {
  CHAIN_INSTRUCTIONS,
  CHAIN_TX_PAGE,
} from '@gyblos/metrics-collector/constants';
import { parseChainTxQuery } from '@gyblos/metrics-collector/stats-chain-txs';

const SIGNATURE =
  '5'.repeat(30) + 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CURSOR = `140-${SIGNATURE}-1`;
const TREASURY = 'Treasury1111';
const SELLER = { nodeId: 'a'.repeat(64), owner: 'SellerOwner' };

function answer() {
  return {
    network: 'solana:devnet',
    programId: 'Program1111',
    mint: 'Mint1111',
    treasury: TREASURY,
    transactions: [
      {
        signature: SIGNATURE,
        instructionIndex: 1,
        slot: 140,
        blockTime: Date.UTC(2026, 10, 20, 14, 2, 30),
        kind: 'distribute',
        channel: 'ChannelAddress1111',
        payee: 'FeePayer1111',
        recipients: ['SellerOwner', TREASURY],
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
const parsed = () => parseChainTxs(answer());
const distribute = (): ChainTx => parsed().transactions[0]!;

void test('the explorer knows exactly the collector instruction kinds and page bounds', () => {
  assert.deepEqual([...CHAIN_TX_KINDS], Object.values(CHAIN_INSTRUCTIONS));
  assert.ok(CHAIN_TXS.pageSize <= CHAIN_TX_PAGE.maxLimit);
  assert.deepEqual(CHAIN_TX_LABELS, {
    open: 'Deposit',
    top_up: 'Top-up',
    settle: 'Settle',
    settle_and_seal: 'Settle and close',
    request_close: 'Close requested',
    seal: 'Closed',
    distribute: 'Paid out',
    reclaim: 'Refunded',
  });
});

void test('the collector query the explorer sends is the canonical one the collector accepts', () => {
  for (const before of [null, CURSOR]) {
    const query = chainTxsQuery(before);
    const params = new URLSearchParams(query);
    assert.ok(parseChainTxQuery(params), query);
    assert.equal(params.get('limit'), String(CHAIN_TXS.pageSize));
    assert.equal(params.get('before'), before);
  }
});

void test('channel transactions are checked at the boundary and amounts stay exact', () => {
  const page = parsed();
  assert.deepEqual(
    [page.programId, page.treasury, page.next],
    ['Program1111', TREASURY, CURSOR],
  );
  assert.deepEqual(page.transactions[0], {
    signature: SIGNATURE,
    instructionIndex: 1,
    slot: 140,
    blockTime: Date.UTC(2026, 10, 20, 14, 2, 30),
    kind: 'distribute',
    channel: 'ChannelAddress1111',
    payee: 'FeePayer1111',
    recipients: ['SellerOwner', TREASURY],
    amount: 1_500_000n,
  });
  assert.equal(page.transactions[1]!.amount, null);
  type Body = ReturnType<typeof answer>;
  const broken = (edit: (body: Body) => void) => {
    const body = answer();
    edit(body);
    return () => parseChainTxs(body);
  };
  for (const edit of [
    (body: Body) => {
      body.transactions[0]!.kind = 'transfer';
    },
    (body: Body) => {
      body.transactions[0]!.amountAtomic = '1.5';
    },
    (body: Body) => {
      Reflect.deleteProperty(body.transactions[0]!, 'signature');
    },
    (body: Body) => {
      Reflect.set(body.transactions[0]!, 'recipients', 'SellerOwner');
    },
    (body: Body) => {
      Reflect.set(body.transactions[0]!, 'slot', '140');
    },
    (body: Body) => {
      body.next = 'not a cursor';
    },
    (body: Body) => {
      Reflect.deleteProperty(body, 'treasury');
    },
    (body: Body) => {
      Reflect.deleteProperty(body, 'transactions');
    },
  ])
    assert.throws(broken(edit), /unexpected source shape/);
  assert.equal(parseChainTxs({ ...answer(), next: null }).next, null);
});

void test('only a well-formed single canonical cursor is passed on to the collector', () => {
  assert.equal(txCursor(CURSOR), CURSOR);
  assert.equal(txCursor(`0-${SIGNATURE}-0`), `0-${SIGNATURE}-0`);
  for (const value of [
    undefined,
    '',
    [CURSOR, CURSOR],
    `${CURSOR}&limit=50`,
    `140-${SIGNATURE}`,
    `0140-${SIGNATURE}-1`,
    `140-${SIGNATURE}-01`,
    `1234567890123456-${SIGNATURE}-0`,
  ])
    assert.equal(txCursor(value), null);
});

void test('a row is labeled plainly with a fixed six-decimal amount and a Solana explorer link', () => {
  const row = txRow(distribute(), sellerOwners([SELLER]), TREASURY);
  assert.deepEqual(row, {
    key: `${SIGNATURE}:1`,
    time: '2026-11-20 14:02',
    kind: 'distribute',
    label: 'Paid out',
    channel: 'ChannelAddress1111',
    payTo: 'SellerOwner',
    seller: SELLER,
    amount: '1.500000',
    muted: false,
    signature: `${SIGNATURE.slice(0, 6)}…${SIGNATURE.slice(-6)}`,
    href: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
  });
  const seal = txRow(parsed().transactions[1]!, new Map(), TREASURY);
  assert.deepEqual(
    [seal.label, seal.time, seal.amount, seal.payTo, seal.seller],
    ['Closed', '—', '—', null, null],
  );
  const settle = (amount: bigint) =>
    txRow({ ...distribute(), kind: 'settle', amount }, new Map(), TREASURY)
      .amount;
  assert.equal(settle(0n), 'no change');
  assert.equal(settle(42n), '0.000042');
  assert.equal(settle(12_345_678_901n), '12,345.678901');
});

void test('the seller is only the listed, unique owner of the channel payout recipient', () => {
  const owners = sellerOwners([SELLER]);
  const credited = (tx: ChainTx, map = owners) =>
    txRow(tx, map, TREASURY).seller;
  assert.deepEqual(credited(distribute()), SELLER);
  assert.equal(
    credited({ ...distribute(), recipients: [TREASURY, 'SellerOwner'] }),
    null,
  );
  assert.equal(
    credited(
      { ...distribute(), recipients: [TREASURY] },
      sellerOwners([{ nodeId: 'b'.repeat(64), owner: TREASURY }]),
    ),
    null,
  );
  assert.equal(
    credited({ ...distribute(), recipients: [], payee: 'SellerOwner' }),
    null,
  );
  assert.equal(
    credited({ ...distribute(), recipients: ['Other', 'SellerOwner'] }),
    null,
  );
  assert.equal(
    credited(
      distribute(),
      sellerOwners([SELLER, { nodeId: 'c'.repeat(64), owner: SELLER.owner }]),
    ),
    null,
  );
  assert.equal(credited(distribute(), sellerOwners([])), null);
});

void test('pager links keep the range and carry the cursor', () => {
  assert.equal(txPageHref(RANGE.defaultDays, null), '/');
  assert.equal(txPageHref(RANGE.defaultDays, CURSOR), `/?before=${CURSOR}`);
  assert.equal(txPageHref(7, CURSOR), `/?range=7&before=${CURSOR}`);
  assert.equal(txPageHref(90, null), '/?range=90');
});
