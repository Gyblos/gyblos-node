// Protects the explorer's scheduled read of the discovery index (which answers no-store): a run stays
// within a fixed number of requests, whatever the number of viewers; seller lists and uptimes are read in
// turns, neither starving the other; a failed part keeps its last read; what is unknown is shown as
// unknown, never as absent.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import { readIndex, snapshotOf } from '@gyblos/explorer/discovery';

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

void test('a run reads a small index whole, at the largest page size, and the render shows it', async () => {
  const { requests } = fakeIndex({ models: { a: ['n1', 'n2'], b: ['n2'] } });
  const stored = await readIndex(null, () => 100);
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
  assert.equal(snapshot.staleFrom, null);
  assert.deepEqual(snapshot.unreadModels, []);
  assert.deepEqual(
    snapshot.sellers.map((seller) => seller.nodeId),
    ['n1', 'n2'],
  );
  assert.ok(snapshot.sellers.every((seller) => seller.uptime));
  assert.ok(snapshot.network);
  assert.equal(snapshot.generatedAt, 7);
});

void test('seller pages are followed to the end', async () => {
  const { requests } = fakeIndex({ models: { a: nodes('n', 5) }, perPage: 2 });
  const snapshot = snapshotOf(await readIndex(null, () => 1), 1);
  assert.equal(count(requests, '/sellers'), 3);
  assert.equal(snapshot.sellers.length, 5);
});

void test('a model whose seller list fails or does not fit in a run stays unknown; the run still stores the rest', async () => {
  fakeIndex({ models: { a: ['n1'], b: nodes('m', 3) } });
  const first = await readIndex(null, () => 0);
  fakeIndex({
    models: { a: ['n1'], b: ['m0'], c: ['c1'] },
    failSellers: new Set(['b', 'c']),
  });
  const second = snapshotOf(await readIndex(first, () => MINUTE), MINUTE);
  // b keeps its last list (the network status, read now, says m1 and m2 are gone); c was never read.
  assert.deepEqual(second.unreadModels, ['c']);
  assert.deepEqual(second.sellers.map((seller) => seller.nodeId).sort(), [
    'm0',
    'n1',
  ]);

  fakeIndex({
    models: { a: ['n1'], b: nodes('m', DISCOVERY.maxRequestsPerRun) },
    perPage: 1,
  });
  const endless = snapshotOf(await readIndex(null, () => 1), 1);
  assert.deepEqual(endless.unreadModels, ['b']);
  assert.deepEqual(
    endless.sellers.map((seller) => seller.nodeId),
    ['n1'],
  );
});

void test('a run stays within its budget; lists it could not read are unknown, read first next run, and uptimes still get their share', async () => {
  const modelCount = DISCOVERY.maxRequestsPerRun;
  const models = Object.fromEntries(
    nodes('m', modelCount).map((id) => [id, [`node-${id}`]]),
  );
  let { requests } = fakeIndex({ models });
  const first = await readIndex(null, () => 1);
  assert.equal(requests.length, DISCOVERY.maxRequestsPerRun);
  const listed = count(requests, '/sellers');
  const unread = snapshotOf(first, 1).unreadModels;
  assert.equal(unread.length, modelCount - listed);
  assert.ok(unread.length > 0);
  assert.equal(snapshotOf(first, 1).sellers.length, listed);

  ({ requests } = fakeIndex({ models }));
  const second = await readIndex(first, () => 2);
  assert.equal(requests.length, DISCOVERY.maxRequestsPerRun);
  for (const modelId of unread)
    assert.ok(
      requests.some((request) => request.includes(`model=${modelId}&`)),
    );
  assert.equal(count(requests, '/uptime'), DISCOVERY.uptimeReservedPerRun);
  assert.deepEqual(snapshotOf(second, 2).unreadModels, []);
});

void test('uptimes are read in turns within the budget, oldest first, a few at a time, and again only once old', async () => {
  const sellers = nodes('n', 100);
  let now = 0;
  let index = fakeIndex({ models: { a: sellers }, uptimeDelayMs: 1 });
  let stored = await readIndex(null, () => now);
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
    stored = await readIndex(stored, () => now);
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
  stored = await readIndex(stored, () => now);
  assert.deepEqual(uptimeNodes(index.requests), firstRead);
});

void test('a failed uptime read keeps the last one', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  const first = await readIndex(null, () => 0);
  fakeIndex({ models: { a: ['n1'] }, failUptime: new Set(['n1']) });
  const later = DISCOVERY.uptimeRefreshMs;
  const second = await readIndex(first, () => later);
  assert.ok(snapshotOf(second, later).sellers[0]?.uptime);
  assert.equal(second.uptimes.n1?.readAt, 0);
});

void test('a seller /network calls offline is not shown; without /network, only recent lists are', async () => {
  fakeIndex({ models: { a: ['n1', 'n2'] }, offline: ['n2'] });
  const withNetwork = snapshotOf(await readIndex(null, () => 0), 0);
  assert.deepEqual(
    withNetwork.sellers.map((seller) => seller.nodeId),
    ['n1'],
  );

  fakeIndex({ models: { a: ['n1', 'n2'] }, offline: null });
  const without = await readIndex(null, () => 0);
  assert.equal(snapshotOf(without, 0).network, null);
  assert.equal(snapshotOf(without, 0).sellers.length, 2);
  // An old list, with no recent network status to say who is still online, is unknown.
  const late = snapshotOf(
    { ...without, readAt: DISCOVERY.staleAfterMs },
    DISCOVERY.staleAfterMs + 1,
  );
  assert.deepEqual(late.sellers, []);
  assert.deepEqual(late.unreadModels, ['a']);
});

void test('a malformed or missing /network answer keeps the last status while it is recent', async () => {
  fakeIndex({ models: { a: ['n1', 'n2'] }, offline: ['n2'] });
  const first = await readIndex(null, () => 0);
  fakeIndex({ models: { a: ['n1', 'n2'] }, offline: 'malformed' });
  const second = await readIndex(first, () => MINUTE);
  const shown = snapshotOf(second, MINUTE);
  assert.ok(shown.network);
  assert.deepEqual(
    shown.sellers.map((seller) => seller.nodeId),
    ['n1'],
  );
  const after = DISCOVERY.staleAfterMs + 1;
  assert.equal(snapshotOf({ ...second, readAt: after }, after).network, null);
});
