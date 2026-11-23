import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAIN_TXS, PAGING, RANGE } from '@gyblos/explorer/constants';
import {
  pageOf,
  parsePage,
  queryHref,
  rangeSwitchHref,
  readQuery,
  tablePager,
  txPager,
} from '@gyblos/explorer/paging';
import { sellerHref } from '@gyblos/explorer/seller-identity';
import { CHAIN_TX_PAGE } from '@gyblos/metrics-collector/constants';

const SIGNATURE =
  '5'.repeat(30) + 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CURSOR = `140-${SIGNATURE}-1`;
const OLDER = `120-${SIGNATURE}-0`;
const rows = (total: number) => Array.from({ length: total }, (_, i) => i + 1);

void test('a page parameter is a positive whole number, anything else is page 1', () => {
  assert.equal(parsePage('3'), 3);
  for (const value of [
    undefined,
    '',
    '0',
    '-2',
    '1.5',
    '02',
    'abc',
    '9'.repeat(PAGING.maxPageDigits + 1),
    ['2', '3'],
  ])
    assert.equal(parsePage(value), 1, String(value));
});

void test('a table shows 25 rows per page and an out-of-range page falls back to page 1', () => {
  assert.equal(PAGING.rowsPerPage, 25);
  const second = pageOf(rows(60), 2);
  assert.deepEqual(second.rows, rows(50).slice(25));
  assert.deepEqual(
    [second.page, second.pages, second.total, second.first, second.last],
    [2, 3, 60, 26, 50],
  );
  const last = pageOf(rows(60), 3);
  assert.deepEqual([last.first, last.last, last.rows.length], [51, 60, 10]);
  const beyond = pageOf(rows(60), 4);
  assert.deepEqual([beyond.page, beyond.first, beyond.last], [1, 1, 25]);
  const empty = pageOf([], 2);
  assert.deepEqual(
    [empty.page, empty.pages, empty.first, empty.last],
    [1, 1, 0, 0],
  );
});

void test('the query reads every table page and drops invalid values', () => {
  const query = readQuery({
    range: '7',
    verified: '1',
    before: CURSOR,
    sellersPage: '2',
    modelsPage: 'x',
    dailyPage: ['2', '3'],
    txPage: '3',
  });
  assert.deepEqual(query, {
    days: 7,
    verified: true,
    before: CURSOR,
    pages: { sellers: 2, transactions: 3 },
  });
  assert.deepEqual(readQuery(new URLSearchParams('txPage=4')).pages, {});
});

void test('every link keeps the range, the filter, the cursor and the other tables pages', () => {
  const query = readQuery({
    range: '90',
    verified: '1',
    before: CURSOR,
    sellersPage: '2',
    offlinePage: '3',
    txPage: '2',
  });
  assert.equal(
    queryHref(query, { pages: { models: 4 } }),
    `/?range=90&verified=1&before=${CURSOR}&sellersPage=2&offlinePage=3&modelsPage=4&txPage=2`,
  );
  assert.equal(
    queryHref(query, { pages: { sellers: 1 } }),
    `/?range=90&verified=1&before=${CURSOR}&offlinePage=3&txPage=2`,
  );
  assert.equal(
    queryHref(query, { before: null }),
    '/?range=90&verified=1&sellersPage=2&offlinePage=3',
  );
  assert.equal(queryHref(readQuery({})), '/');
  for (const param of Object.values(PAGING.params))
    assert.ok(
      queryHref(readQuery({ before: CURSOR, [param]: '2' })).includes(
        `${param}=2`,
      ),
      param,
    );
});

void test('a date range switch keeps every table page', () => {
  assert.equal(
    rangeSwitchHref('dailyPage=2&demandPage=3&chainDailyPage=4', 7),
    '/?range=7&dailyPage=2&demandPage=3&chainDailyPage=4',
  );
  assert.equal(
    rangeSwitchHref(`range=7&before=${CURSOR}&txPage=2`, RANGE.defaultDays),
    `/?before=${CURSOR}&txPage=2`,
  );
});

void test('a table pager counts its rows and links First, Previous and Next', () => {
  const query = readQuery({ range: '7', offlinePage: '2' });
  assert.equal(tablePager(query, 'models', pageOf(rows(25), 1)), null);
  const first = tablePager(query, 'models', pageOf(rows(1200), 1));
  assert.deepEqual(first, {
    rows: 'Rows 1–25 of 1,200',
    links: [{ label: 'Next', href: '/?range=7&offlinePage=2&modelsPage=2' }],
  });
  const middle = tablePager(query, 'offline', pageOf(rows(60), 2));
  assert.deepEqual(middle, {
    rows: 'Rows 26–50 of 60',
    links: [
      { label: 'First', href: '/?range=7' },
      { label: 'Previous', href: '/?range=7' },
      { label: 'Next', href: '/?range=7&offlinePage=3' },
    ],
  });
});

void test('the transaction pager counts rows without a total and keeps its cursor paging', () => {
  assert.equal(CHAIN_TXS.pageRows, CHAIN_TX_PAGE.defaultLimit);
  assert.equal(txPager(readQuery({}), 3, null), null);
  assert.deepEqual(txPager(readQuery({ sellersPage: '2' }), 25, OLDER), {
    rows: 'Rows 1–25',
    links: [
      {
        label: 'Older',
        href: `/?before=${OLDER}&sellersPage=2&txPage=2`,
      },
    ],
  });
  assert.deepEqual(
    txPager(readQuery({ before: CURSOR, txPage: '2', range: '7' }), 25, OLDER),
    {
      rows: 'Rows 26–50',
      links: [
        { label: 'Newest', href: '/?range=7' },
        { label: 'Older', href: `/?range=7&before=${OLDER}&txPage=3` },
      ],
    },
  );
  assert.deepEqual(txPager(readQuery({ before: CURSOR }), 4, null), {
    rows: null,
    links: [{ label: 'Newest', href: '/' }],
  });
});

void test('a seller links to its own page by NodeId', () => {
  assert.equal(sellerHref('a'.repeat(64)), `/sellers/${'a'.repeat(64)}`);
});
