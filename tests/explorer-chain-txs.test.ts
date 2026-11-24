import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAIN_TX_KINDS,
  CHAIN_TX_LABELS,
  chainTxsQuery,
  chainTxsUrl,
  parseChainTxs,
  sellerOwners,
  txCursor,
  txRow,
  type ChainTx,
} from '@gyblos/explorer/chain-txs-shape';
import { CHAIN_TXS, RANGE } from '@gyblos/explorer/constants';
import {
  queryHref,
  readQuery,
  sectionRangeHref,
} from '@gyblos/explorer/paging';
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
        split: {
          paidOut: '1500000',
          gyblosFees: '0',
          programTreasury: '0',
          refunded: '0',
          channels: 1,
          unclassified: '0',
        },
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
  assert.equal(CHAIN_TXS.param, CHAIN_TX_PAGE.params.BEFORE);
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
    assert.equal(params.get('limit'), '5');
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
    recipients: ['SellerOwner', TREASURY],
    amount: 1_500_000n,
    split: {
      paidOut: 1_500_000n,
      gyblosFees: 0n,
      programTreasury: 0n,
      refunded: 0n,
      channels: 1,
      unclassified: 0n,
    },
    batched: false,
  });
  assert.equal(page.transactions[1]!.amount, null);
  const withoutPayee = answer();
  Reflect.deleteProperty(withoutPayee.transactions[0]!, 'payee');
  assert.ok(!('payee' in parseChainTxs(withoutPayee).transactions[0]!));
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
    parts: parts(null, null, null),
    detail: [],
    shared: false,
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
  assert.equal(credited({ ...distribute(), recipients: [] }), null);
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

const txPageHref = (days: number, before: string | null, verified = '') =>
  queryHref(readQuery({ range: String(days), verified }), { before });

void test('pager links keep the range and carry the cursor', () => {
  assert.equal(txPageHref(RANGE.defaultDays, null), '/');
  assert.equal(txPageHref(RANGE.defaultDays, CURSOR), `/?before=${CURSOR}`);
  assert.equal(txPageHref(7, CURSOR), `/?range=7&before=${CURSOR}`);
  assert.equal(txPageHref(90, null), '/?range=90');
});

void test('every page URL asks for a 5-row page in canonical order', () => {
  assert.equal(
    chainTxsUrl('https://c.test/v1', null),
    'https://c.test/v1/stats/chain/txs?limit=5',
  );
  assert.equal(
    chainTxsUrl('https://c.test/v1', CURSOR),
    `https://c.test/v1/stats/chain/txs?before=${CURSOR}&limit=5`,
  );
});

void test('transaction pages keep the verified seller filter', () => {
  assert.equal(
    txPageHref(7, CURSOR, '1'),
    `/?range=7&verified=1&before=${CURSOR}`,
  );
  assert.equal(
    sectionRangeHref(`verified=1&before=${CURSOR}`, 'payments', 30),
    `/?verified=1&before=${CURSOR}`,
  );
});

type Body = ReturnType<typeof answer>;
const SPLIT = {
  paidOut: '213',
  gyblosFees: '9',
  programTreasury: '0',
  refunded: '999778',
  channels: 1,
  unclassified: '0',
};
function payout(kind: string, amountAtomic: string, split: object) {
  const body: Body = answer();
  Object.assign(body.transactions[0]!, { kind, amountAtomic, split });
  return parseChainTxs(body).transactions[0]!;
}

type Part = string | null;
const parts = (gyblosFees: Part, programTreasury: Part, refunded: Part) =>
  ({ gyblosFees, programTreasury, refunded }) as const;

void test('a paid out row shows the seller amount and the rest of the split, one column per part', () => {
  const tx = payout('distribute', '213', SPLIT);
  assert.deepEqual(tx.split, {
    paidOut: 213n,
    gyblosFees: 9n,
    programTreasury: 0n,
    refunded: 999_778n,
    channels: 1,
    unclassified: 0n,
  });
  const row = txRow(tx, new Map(), TREASURY);
  assert.deepEqual(
    [row.amount, row.muted, row.parts, row.detail, row.shared],
    ['0.000213', false, parts('0.000009', null, '0.999778'), [], false],
  );
  const program = payout('distribute', '213', {
    ...SPLIT,
    programTreasury: '3',
  });
  const shown = txRow(program, new Map(), TREASURY).parts;
  assert.deepEqual(shown, parts('0.000009', '0.000003', '0.999778'));
});

void test('a refunded row shows just its refund, and a zero payout is muted', () => {
  const refund = txRow(
    payout('reclaim', '500', {
      ...SPLIT,
      paidOut: '0',
      gyblosFees: '0',
      refunded: '500',
    }),
    new Map(),
    TREASURY,
  );
  assert.deepEqual(
    [refund.label, refund.amount, refund.parts, refund.detail],
    ['Refunded', '0.000500', parts(null, null, null), []],
  );
  const mixed = payout('reclaim', '10', {
    ...SPLIT,
    paidOut: '2',
    refunded: '10',
  });
  assert.ok(
    txRow(mixed, new Map(), TREASURY).detail.includes('to sellers 0.000002'),
  );
  const nothing = txRow(
    payout('distribute', '0', { ...SPLIT, paidOut: '0' }),
    new Map(),
    TREASURY,
  );
  assert.deepEqual([nothing.amount, nothing.muted], ['0.000000', true]);
});

void test('a split shared by several channels is labeled as a transaction total and credits no seller', () => {
  const row = txRow(
    payout('distribute', '213', { ...SPLIT, channels: 2 }),
    sellerOwners([SELLER]),
    TREASURY,
  );
  assert.deepEqual(
    [row.shared, row.seller, row.detail[0]],
    [true, null, 'total of 2 channels'],
  );
});

void test('the split is parsed strictly, and an older collector payout amount is not shown as seller proceeds', () => {
  for (const broken of [
    { paidOut: '213', gyblosFees: '9', programTreasury: '0', channels: 1 },
    { ...SPLIT, paidOut: '2.13' },
    { ...SPLIT, gyblosFee: '9', gyblosFees: undefined },
    { ...SPLIT, channels: '1' },
    { ...SPLIT, unclassified: undefined },
    '213',
  ]) {
    const bad: Body = answer();
    Object.assign(bad.transactions[0]!, { split: broken });
    assert.throws(() => parseChainTxs(bad), /unexpected source shape/);
  }
  const older: Body = answer();
  Reflect.deleteProperty(older.transactions[0]!, 'split');
  const legacy = parseChainTxs(older).transactions[0]!;
  assert.deepEqual([legacy.split, legacy.amount], [null, null]);
  assert.equal(txRow(legacy, new Map(), TREASURY).amount, '—');
  const kept = parseChainTxs(answer()).transactions[1]!;
  assert.equal(kept.kind, 'seal');
  const settle: Body = answer();
  Object.assign(settle.transactions[1]!, {
    kind: 'settle',
    amountAtomic: '42',
  });
  assert.equal(parseChainTxs(settle).transactions[1]!.amount, 42n);
});

void test('a payout that accounts for less than the vault outflow shows the unclassified remainder', () => {
  const row = txRow(
    payout('distribute', '213', { ...SPLIT, unclassified: '40' }),
    new Map(),
    TREASURY,
  );
  assert.equal(row.detail.at(-1), 'unclassified 0.000040');
});
