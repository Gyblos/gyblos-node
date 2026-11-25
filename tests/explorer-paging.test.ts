import assert from 'node:assert/strict';
import test from 'node:test';

import { getTransactionTable } from '@gyblos/explorer/chain-txs';
import { operationBefore } from '@gyblos/explorer/chain-txs-shape';
import { CHAIN_TXS, PAGING, RANGE } from '@gyblos/explorer/constants';
import {
  canonicalPageHref,
  movedHomeHref,
  pageOf,
  pageRedirect,
  parsePage,
  queryHref,
  readQuery,
  sectionRangeHref,
  sortedRows,
  sortHref,
  tablePage,
  tablePager,
  txPager,
} from '@gyblos/explorer/paging';
import { offersCaption, sellerHref } from '@gyblos/explorer/seller-identity';
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

void test('a table shows 5 rows per page and an out-of-range page falls back to page 1', () => {
  assert.equal(PAGING.rowsPerPage, 5);
  const second = pageOf(rows(12), 2);
  assert.deepEqual(second.rows, rows(10).slice(5));
  assert.deepEqual(
    [second.page, second.pages, second.total, second.first, second.last],
    [2, 3, 12, 6, 10],
  );
  const last = pageOf(rows(12), 3);
  assert.deepEqual([last.first, last.last, last.rows.length], [11, 12, 2]);
  const beyond = pageOf(rows(12), 4);
  assert.deepEqual([beyond.page, beyond.first, beyond.last], [1, 1, 5]);
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
    path: '/',
    days: 7,
    ranges: {},
    sorts: {},
    verified: true,
    before: CURSOR,
    pages: { sellers: 2, transactions: 3 },
  });
  assert.deepEqual(readQuery(new URLSearchParams('txPage=4')).pages, {
    transactions: 4,
  });
});

void test('every link keeps the range, the filter, the cursor and the other tables pages', () => {
  const query = readQuery({
    range: '30',
    verified: '1',
    before: CURSOR,
    sellersPage: '2',
    offlinePage: '3',
    txPage: '2',
  });
  assert.equal(
    queryHref(query, { pages: { models: 4 } }),
    `/?range=30&verified=1&before=${CURSOR}&sellersPage=2&offlinePage=3&modelsPage=4&txPage=2`,
  );
  assert.equal(
    queryHref(query, { pages: { sellers: 1 } }),
    `/?range=30&verified=1&before=${CURSOR}&offlinePage=3&txPage=2`,
  );
  assert.equal(
    queryHref(query, { before: null }),
    '/?range=30&verified=1&sellersPage=2&offlinePage=3',
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

void test("a section's range resets only that section's tables, and an old range link still sets the rest", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(RANGE.sections).map(([key, value]) => [key, value.tables]),
    ),
    {
      overview: [],
      chart: [],
      models: ['models'],
      usage: ['daily', 'demand'],
      payments: ['chainDaily'],
      activity: ['models', 'daily'],
    },
  );
  assert.equal(
    sectionRangeHref(
      `modelsPage=2&dailyPage=2&demandPage=3&chainDailyPage=4&sellersPage=2&offlinePage=3&before=${CURSOR}&txPage=2`,
      'usage',
      7,
    ),
    `/?usageRange=7&before=${CURSOR}&sellersPage=2&offlinePage=3&modelsPage=2&chainDailyPage=4&txPage=2`,
  );
  assert.equal(
    sectionRangeHref(`range=7&before=${CURSOR}&txPage=2`, 'payments', 30),
    `/?range=7&paymentsRange=30&before=${CURSOR}&txPage=2`,
  );
  assert.equal(canonicalPageHref({ usageRange: '5' }), '/');
  assert.equal(canonicalPageHref({ usageRange: '7' }), null);
});

void test('a table pager links every page it can show to its table, keeping the other parameters', () => {
  const query = readQuery({ range: '7', offlinePage: '2' });
  const single = tablePager(query, 'models', pageOf(rows(5), 1));
  assert.equal(single?.rows, 'Rows 1–5 of 5');
  assert.equal(single?.pages, 1);
  assert.equal(tablePager(query, 'models', pageOf([], 1))?.rows, '0 rows');
  const models = `#${PAGING.anchors.models}`;
  const first = tablePager(query, 'models', pageOf(rows(1200), 1));
  assert.deepEqual(
    [first?.rows, first?.page, first?.pages, first?.showPages],
    ['Rows 1–5 of 1,200', 1, 240, true],
  );
  assert.deepEqual(
    Object.keys(first?.hrefs ?? {}).map(Number),
    [1, 2, 3, 4, 5, 236, 237, 238, 239, 240],
  );
  assert.equal(first?.hrefs[1], `/?range=7&offlinePage=2${models}`);
  assert.equal(
    first?.hrefs[2],
    `/?range=7&offlinePage=2&modelsPage=2${models}`,
  );
  const anchor = `#${PAGING.anchors.offline}`;
  const middle = tablePager(query, 'offline', pageOf(rows(12), 2));
  assert.deepEqual(middle?.hrefs, {
    1: `/?range=7${anchor}`,
    2: `/?range=7&offlinePage=2${anchor}`,
    3: `/?range=7&offlinePage=3${anchor}`,
  });
  assert.deepEqual(
    [middle?.rows, middle?.previousLabel, middle?.nextLabel],
    ['Rows 6–10 of 12', 'Previous', 'Next'],
  );
});

void test('an out-of-range page is replaced by the canonical URL without it', () => {
  const query = readQuery({ range: '7', modelsPage: '9', dailyPage: '2' });
  assert.equal(
    pageRedirect(query, 'models', tablePage(query, 'models', rows(3))),
    '/?range=7&dailyPage=2',
  );
  assert.equal(
    pageRedirect(query, 'daily', tablePage(query, 'daily', rows(30))),
    null,
  );
  assert.equal(
    pageRedirect(query, 'sellers', tablePage(query, 'sellers', rows(3))),
    null,
  );
});

void test('a partial source never rewrites a table page', () => {
  const query = readQuery({ modelsPage: '3' });
  const page = tablePage(query, 'models', rows(6));
  assert.equal(pageRedirect(query, 'models', page, false), null);
  assert.equal(pageRedirect(query, 'models', page, true), '/');
  assert.equal(pageRedirect(query, 'models', page), '/');
});

void test('an invalid page parameter is dropped from the URL', () => {
  assert.equal(
    canonicalPageHref({ range: '7', modelsPage: 'abc' }),
    '/?range=7',
  );
  assert.equal(canonicalPageHref({ modelsPage: ['2', '3'] }), '/');
  assert.equal(
    canonicalPageHref({ dailyPage: '1', sellersPage: '2' }),
    '/?sellersPage=2',
  );
  assert.equal(canonicalPageHref({ txPage: '2' }), null);
  assert.equal(canonicalPageHref({ sellersPage: '2', other: 'x' }), null);
  assert.equal(canonicalPageHref({ before: CURSOR, txPage: '2' }), null);
  assert.equal(canonicalPageHref({}), null);
});

void test('operations show the real last page and link back to the immediately preceding page', () => {
  assert.equal(CHAIN_TXS.pageRows, PAGING.rowsPerPage);
  assert.ok(CHAIN_TXS.pageRows <= CHAIN_TX_PAGE.maxLimit);
  const pager = txPager(
    readQuery({ before: OLDER, txPage: '3' }),
    pageOf(rows(13), 3),
  );
  assert.equal(pager.rows, 'Rows 11–13 of 13');
  assert.equal(pager.pages, 3);
  assert.equal(pager.showPages, true);
  assert.match(pager.hrefs[2] ?? '', /txPage=2/);
  assert.ok(!pager.hrefs[2]?.includes('before='));
  assert.equal(txPager(readQuery({}), pageOf([], 1)).pages, 1);
});

void test('the Sellers caption counts offers and sellers apart from rows', () => {
  assert.equal(offersCaption(90, 60), '90 offers from 60 sellers');
  assert.equal(offersCaption(1, 1), '1 offer from 1 seller');
  assert.equal(offersCaption(1_200, 2), '1,200 offers from 2 sellers');
});

void test('a seller links to its own page by NodeId', () => {
  assert.equal(sellerHref('a'.repeat(64)), `/sellers/${'a'.repeat(64)}`);
});

void test('switching a section range keeps a valid transaction page', () => {
  assert.equal(
    sectionRangeHref(`before=${CURSOR}`, 'payments', 7),
    `/?paymentsRange=7&before=${CURSOR}`,
  );
  assert.equal(
    sectionRangeHref(
      `paymentsRange=7&before=${CURSOR}`,
      'payments',
      RANGE.defaultDays,
    ),
    `/?before=${CURSOR}`,
  );
  assert.equal(
    sectionRangeHref('usageRange=7', 'usage', 30),
    '/?usageRange=30',
  );
  assert.equal(
    sectionRangeHref('usageRange=7&before=bad', 'usage', RANGE.defaultDays),
    '/',
  );
  assert.equal(sectionRangeHref('', 'overview', 7), '/?overviewRange=7');
});

void test('a sortable column cycles highest first, lowest first and unsorted, back on page 1', () => {
  const query = readQuery({ sellersPage: '2', modelsSort: '-input' });
  const anchor = `#${PAGING.anchors.sellers}`;
  assert.equal(
    sortHref(query, 'sellers', 'output'),
    `/?sellersSort=-output&modelsSort=-input${anchor}`,
  );
  const desc = readQuery({ sellersSort: '-output' });
  assert.equal(
    sortHref(desc, 'sellers', 'output'),
    `/?sellersSort=output${anchor}`,
  );
  const asc = readQuery({ sellersSort: 'output' });
  assert.equal(sortHref(asc, 'sellers', 'output'), `/${anchor}`);
  const daily = `#${PAGING.anchors.daily}`;
  assert.equal(
    sortHref(readQuery({}), 'daily', 'day', true),
    `/?dailySort=day${daily}`,
  );
  assert.equal(
    sortHref(readQuery({ dailySort: 'day' }), 'daily', 'day', true),
    `/?dailySort=-day${daily}`,
  );
  assert.equal(
    sortHref(readQuery({ dailySort: '-day' }), 'daily', 'day', true),
    `/${daily}`,
  );
  assert.equal(canonicalPageHref({ modelsRange: '7.0' }), '/');
  assert.equal(canonicalPageHref({ sellersSort: 'owner' }), '/');
  assert.equal(canonicalPageHref({ sellersSort: '-uptimeDay' }), null);
  const rows = [{ v: 2 }, { v: null }, { v: 9 }, { v: 4 }];
  const by = { value: (row: { v: number | null }) => row.v };
  assert.deepEqual(
    sortedRows(rows, { key: 'value', desc: true }, by).map((row) => row.v),
    [9, 4, 2, null],
  );
  assert.deepEqual(
    sortedRows(rows, { key: 'value', desc: false }, by).map((row) => row.v),
    [2, 4, 9, null],
  );
  assert.equal(sortedRows(rows, undefined, by), rows);
});

void test('a home link to a table that moved to its own page redirects there with its parameters', () => {
  assert.equal(movedHomeHref({ modelsPage: '2' }), '/models?modelsPage=2');
  assert.equal(
    movedHomeHref({ before: CURSOR, txPage: '2', verified: '1' }),
    `/transactions?before=${CURSOR}&txPage=2&verified=1`,
  );
  assert.equal(movedHomeHref({ usageRange: '7' }), '/stats?usageRange=7');
  assert.equal(
    movedHomeHref({ chainDailySort: 'day' }),
    '/stats?chainDailySort=day',
  );
  assert.equal(movedHomeHref({ offlinePage: '3' }), '/sellers?offlinePage=3');
  assert.equal(movedHomeHref({ overviewRange: '7', verified: '1' }), null);
  assert.equal(movedHomeHref({}), null);
  assert.deepEqual(PAGING.sortKeys.models, ['input', 'output', 'context']);
});

void test('overview table links keep the range and paginate inside Network', () => {
  const query = { ...readQuery({ overviewRange: '7' }), overviewTables: true };
  const view = tablePager(query, 'sellers', pageOf(rows(8), 1));
  const url = new URL(view!.hrefs[2]!, 'https://example.org');
  assert.equal(movedHomeHref(url.searchParams), null);
  assert.equal(readQuery(url.searchParams).pages.sellers, 2);
  assert.equal(readQuery(url.searchParams).ranges.overview, 7);
});

void test('an operation opens the indexed instruction through the exclusive collector cursor', () => {
  assert.equal(operationBefore(CURSOR), `140-${SIGNATURE}-2`);
  assert.equal(operationBefore('invalid'), null);
});

void test('legacy 90-day bookmarks become All while retaining the surrounding page state', () => {
  assert.equal(
    canonicalPageHref({ range: '90', verified: '1' }),
    '/?verified=1',
  );
  assert.equal(
    canonicalPageHref(
      { range: '7', modelsRange: '90', modelsPage: '2' },
      '/models',
    ),
    '/models?range=7&modelsRange=all&modelsPage=2',
  );
  assert.equal(readQuery({}).days, 'all');
});

void test('a cold deep link reads one operation page and its recipient-scoped total', async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    urls.push(new URL(input));
    return Response.json({
      programId: 'program',
      treasury: 'treasury',
      total: 100001,
      page: 20001,
      next: null,
      transactions: [
        {
          signature: SIGNATURE,
          instructionIndex: 0,
          slot: 100,
          blockTime: null,
          kind: 'open',
          channel: 'channel',
          recipients: [],
          amountAtomic: '1',
        },
      ],
    });
  });
  const table = await getTransactionTable(
    readQuery({ txPage: '20001' }),
    'recipient',
  );
  assert.equal(urls.length, 1);
  assert.equal(urls[0]?.searchParams.get('page'), '20001');
  assert.equal(urls[0]?.searchParams.get('recipient'), 'recipient');
  assert.equal(table.pager.page, 20001);
  assert.equal(table.pager.pages, 20001);
  assert.equal(table.transactions[0]?.signature, SIGNATURE);
});
