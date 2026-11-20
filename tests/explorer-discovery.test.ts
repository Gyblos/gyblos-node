// Protects the explorer's scheduled read of the discovery index (which answers no-store): a run stays
// within a fixed number of requests, whatever the number of viewers; a catalog too large for one run is
// carried on by the next ones and shown only once whole, so the page never shows part of the index as
// all of it; a failed page is read again, and a read that never ends begins again; uptimes are read in
// turns with a share of every run kept for them.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import {
  readIndex,
  snapshotOf,
  type StoredDiscovery,
} from '@gyblos/explorer/discovery';

import {
  count,
  fakeIndex,
  MINUTE,
  nodes,
  uptimeNodes,
} from './support/explorer-discovery';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// An index of `n` models with one seller each.
const manyModels = (n: number) =>
  Object.fromEntries(nodes('m', n).map((id) => [id, [`node-${id}`]]));
const shownNodes = (stored: StoredDiscovery, now: number) =>
  snapshotOf(stored, now).sellers.map((seller) => seller.nodeId);

void test('a run reads a small index whole, at the largest page size, and the render shows it', async () => {
  const { requests } = fakeIndex({ models: { a: ['n1', 'n2'], b: ['n2'] } });
  const { stored, error } = await readIndex(null, () => 100);
  assert.equal(error, null);
  assert.equal(requests.length, 1 + 1 + 2 + 2);
  assert.ok(
    requests
      .filter((request) => request.includes('/sellers'))
      .every((request) =>
        request.includes(`limit=${DISCOVERY.sellersPerPage}`),
      ),
  );
  const snapshot = snapshotOf(stored, 100);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.readAt, null);
  assert.deepEqual(shownNodes(stored, 100), ['n1', 'n2']);
  assert.ok(snapshot.sellers.every((seller) => seller.uptime));
  assert.ok(snapshot.network);
  assert.equal(snapshot.generatedAt, 7);
});

void test('seller pages are followed to the end', async () => {
  const { requests } = fakeIndex({ models: { a: nodes('n', 5) }, perPage: 2 });
  const { stored } = await readIndex(null, () => 1);
  assert.equal(count(requests, '/sellers'), 3);
  assert.equal(shownNodes(stored, 1).length, 5);
});

void test('a catalog too large for one run is carried on by the next runs and shown only once whole', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const models = { a: ['n1'], ...manyModels(DISCOVERY.maxRequestsPerRun) };
  let runs = 0;
  let now = 0;
  do {
    now += 2 * MINUTE;
    runs += 1;
    const { requests } = fakeIndex({ models });
    ({ stored } = await readIndex(stored, () => now));
    assert.ok(requests.length <= DISCOVERY.maxRequestsPerRun);
    if (stored.pending) assert.deepEqual(shownNodes(stored, now), ['n1']);
  } while (stored.pending);
  assert.ok(runs > 1);
  assert.equal(shownNodes(stored, now).length, Object.keys(models).length);
});

void test('while a large catalog is read, every run still reads its share of due uptimes', async () => {
  fakeIndex({ models: { a: nodes('n', 20) } });
  let { stored } = await readIndex(null, () => 0);
  assert.ok(snapshotOf(stored, 0).sellers.every((seller) => seller.uptime));
  const { requests } = fakeIndex({
    models: { a: nodes('n', 20), ...manyModels(DISCOVERY.maxRequestsPerRun) },
  });
  ({ stored } = await readIndex(stored, () => DISCOVERY.uptimeRefreshMs));
  assert.ok(stored.pending);
  assert.equal(requests.length, DISCOVERY.maxRequestsPerRun);
  assert.equal(count(requests, '/uptime'), DISCOVERY.uptimeReservedPerRun);
});

void test('a failed page ends the run’s reading; the model is read again from its first page next run', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const grown = { a: ['n1'], b: nodes('p', 5) };
  let index = fakeIndex({
    models: grown,
    perPage: 2,
    failSellers: new Set(['b']),
  });
  ({ stored } = await readIndex(stored, () => 2 * MINUTE));
  assert.ok(stored.pending);
  assert.equal(count(index.requests, '/sellers'), 2);
  assert.deepEqual(shownNodes(stored, 2 * MINUTE), ['n1']);

  index = fakeIndex({ models: grown, perPage: 2 });
  ({ stored } = await readIndex(stored, () => 4 * MINUTE));
  assert.equal(stored.pending, null);
  assert.ok(
    index.requests.some(
      (request) => request.includes('model=b') && !request.includes('cursor'),
    ),
  );
  assert.equal(shownNodes(stored, 4 * MINUTE).length, 6);
});

void test('a catalog read that never ends begins again, and the last whole catalog stays shown', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  fakeIndex({ models: { a: ['n1'], b: ['n2'] }, failSellers: new Set(['b']) });
  ({ stored } = await readIndex(stored, () => MINUTE));
  const began = stored.pending?.startedAt;
  ({ stored } = await readIndex(stored, () => 2 * MINUTE));
  assert.equal(stored.pending?.startedAt, began);
  const later = MINUTE + DISCOVERY.restartAfterMs;
  const { requests } = fakeIndex({
    models: { a: ['n1'], b: ['n2'] },
    failSellers: new Set(['b']),
  });
  ({ stored } = await readIndex(stored, () => later));
  assert.equal(count(requests, '/models'), 1);
  assert.equal(stored.pending?.startedAt, later);
  assert.deepEqual(shownNodes(stored, later), ['n1']);
  assert.equal(snapshotOf(stored, later).readAt, 0);
});

void test('uptimes are read in turns, oldest first, a few at a time, and again only once old', async () => {
  const sellers = nodes('n', 100);
  let now = 0;
  let index = fakeIndex({ models: { a: sellers }, uptimeDelayMs: 1 });
  let { stored } = await readIndex(null, () => now);
  assert.equal(index.requests.length, DISCOVERY.maxRequestsPerRun);
  assert.ok(index.uptimes.most <= DISCOVERY.uptimeConcurrency);
  const firstRead = uptimeNodes(index.requests);
  assert.equal(
    snapshotOf(stored, now).sellers.filter((seller) => seller.uptime).length,
    firstRead.size,
  );

  const seen = new Set(firstRead);
  while (seen.size < sellers.length) {
    now += 2 * MINUTE;
    index = fakeIndex({ models: { a: sellers } });
    ({ stored } = await readIndex(stored, () => now));
    const read = uptimeNodes(index.requests);
    assert.ok(read.size > 0);
    for (const nodeId of read) {
      assert.ok(!seen.has(nodeId ?? ''), 'a never-read uptime comes first');
      seen.add(nodeId ?? '');
    }
  }
  assert.ok(snapshotOf(stored, now).sellers.every((seller) => seller.uptime));

  now = DISCOVERY.uptimeRefreshMs;
  index = fakeIndex({ models: { a: sellers } });
  ({ stored } = await readIndex(stored, () => now));
  assert.deepEqual(uptimeNodes(index.requests), firstRead);
});

void test('a failed uptime read keeps the last one; an uptime goes only with its seller', async () => {
  fakeIndex({ models: { a: ['n1', 'n2'] } });
  let { stored } = await readIndex(null, () => 0);
  const later = DISCOVERY.uptimeRefreshMs;
  fakeIndex({ models: { a: ['n1', 'n2'] }, failUptime: new Set(['n1']) });
  ({ stored } = await readIndex(stored, () => later));
  assert.equal(stored.uptimes.n1?.readAt, 0);
  assert.ok(snapshotOf(stored, later).sellers[0]?.uptime);

  fakeIndex({ models: { a: ['n1'] } });
  ({ stored } = await readIndex(stored, () => later + 1));
  assert.ok(stored.uptimes.n1);
  assert.equal(stored.uptimes.n2, undefined);
});

void test('a malformed or missing /network answer leaves the catalog without one', async () => {
  for (const offline of ['malformed', null] as const) {
    fakeIndex({ models: { a: ['n1'] }, offline });
    const { stored, error } = await readIndex(null, () => 0);
    assert.equal(error, null);
    assert.equal(snapshotOf(stored, 0).network, null);
    assert.deepEqual(shownNodes(stored, 0), ['n1']);
  }
});
