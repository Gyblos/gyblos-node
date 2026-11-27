import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyticsRequest,
  analyticsRows,
  analyticsWindow,
  formatTable,
  parseAccountId,
  parseAnalytics,
  parseDatabaseInfo,
  parseToken,
} from './analytics';
import { D1_ANALYTICS_ERRORS } from './constants';

const DISCOVERY = 'd6270b3c-bc9e-4535-8612-d869359266ac';
const COLLECTOR = 'f6c2dddf-5911-414c-82ff-1f402d7db193';
const group = (databaseId: string, reads: number) => ({
  dimensions: { databaseId },
  sum: {
    readQueries: reads,
    writeQueries: 2,
    rowsRead: 30,
    rowsWritten: 4,
  },
  quantiles: { queryBatchTimeMsP50: 0.25, queryBatchTimeMsP95: 1.5 },
});
const response = (groups: unknown[]) => ({
  data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: groups }] } },
  errors: null,
});
const failsWith = (code: string) => (error: unknown) =>
  error instanceof Error && error.message === code;

void test('the window is the seven complete UTC days before today', () => {
  assert.deepEqual(analyticsWindow(Date.parse('2026-11-26T15:00:00Z')), {
    start: '2026-11-19',
    end: '2026-11-25',
  });
});

void test('the request filters by account and database ids and carries no credential', () => {
  const request = analyticsRequest('account', [DISCOVERY, COLLECTOR], {
    start: '2026-11-19',
    end: '2026-11-25',
  });
  assert.deepEqual(request.variables, {
    accountTag: 'account',
    databaseIds: [DISCOVERY, COLLECTOR],
    start: '2026-11-19',
    end: '2026-11-25',
  });
  assert.match(request.query, /d1AnalyticsAdaptiveGroups/);
  assert.match(request.query, /queryBatchTimeMsP95/);
});

void test('a GraphQL response becomes totals per database id', () => {
  const totals = parseAnalytics(
    response([group(DISCOVERY, 10), group(COLLECTOR, 20)]),
  );
  assert.deepEqual(totals.get(DISCOVERY), {
    readQueries: 10,
    writeQueries: 2,
    rowsRead: 30,
    rowsWritten: 4,
    p50Ms: 0.25,
    p95Ms: 1.5,
  });
  assert.equal(totals.get(COLLECTOR)?.readQueries, 20);
});

void test('GraphQL errors or a malformed group are refused with a static code', () => {
  for (const body of [
    { data: null, errors: [{ message: 'secret detail' }] },
    response([{ ...group(DISCOVERY, 1), sum: { readQueries: '1' } }]),
    response([{ ...group(DISCOVERY, 1), dimensions: {} }]),
    { data: { viewer: { accounts: [] } } },
    response([{ ...group(DISCOVERY, 1), quantiles: null }]),
    { errors: [] },
    'not json',
  ])
    assert.throws(
      () => parseAnalytics(body),
      failsWith(D1_ANALYTICS_ERRORS.BAD_RESPONSE),
    );
});

void test('wrangler outputs are parsed for the database id and size, the token and the only account', () => {
  assert.deepEqual(
    parseDatabaseInfo(
      JSON.stringify({ uuid: DISCOVERY, database_size: 303_104 }),
    ),
    { id: DISCOVERY, sizeBytes: 303_104 },
  );
  assert.throws(
    () => parseDatabaseInfo('{}'),
    failsWith(D1_ANALYTICS_ERRORS.BAD_DATABASE_INFO),
  );
  assert.equal(
    parseToken(JSON.stringify({ type: 'oauth', token: 'synthetic' })),
    'synthetic',
  );
  assert.throws(
    () => parseToken('{"type":"oauth"}'),
    failsWith(D1_ANALYTICS_ERRORS.NO_TOKEN),
  );
  assert.equal(
    parseAccountId(JSON.stringify({ accounts: [{ id: 'only' }] })),
    'only',
  );
  assert.throws(
    () =>
      parseAccountId(JSON.stringify({ accounts: [{ id: 'a' }, { id: 'b' }] })),
    failsWith(D1_ANALYTICS_ERRORS.NO_ACCOUNT),
  );
});

void test('rows list every database, with zeros when D1 reported no queries', () => {
  const rows = analyticsRows(
    [
      { name: 'gyblos-discovery', id: DISCOVERY, sizeBytes: 3_145_728 },
      { name: 'gyblos-collector', id: COLLECTOR, sizeBytes: 0 },
    ],
    parseAnalytics(response([group(DISCOVERY, 10)])),
  );
  assert.deepEqual(rows, [
    ['gyblos-discovery', '3.00', '10', '2', '30', '4', '0.25', '1.50'],
    ['gyblos-collector', '0.00', '0', '0', '0', '0', '-', '-'],
  ]);
});

void test('a table pads every column to its widest cell', () => {
  assert.equal(
    formatTable(['a', 'bb'], [['ccc', 'd']]),
    'a    bb\n---  --\nccc  d',
  );
});
