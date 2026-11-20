// Protects the explorer's scheduled read of the discovery index (which answers no-store): a run stays
// within a fixed number of requests and time; a catalog with more models than fit
// in one run is carried on by the next ones and shown only once whole, each model read within one run, so
// the page never shows part of the index as all of it; a failed page or uptime keeps the last good read
// and is tried again later without starving the rest; what went wrong is reported as fixed codes.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY, FETCH } from '@gyblos/explorer/constants';
import { readIndex, type StoredDiscovery } from '@gyblos/explorer/discovery';
import { snapshotOf } from '@gyblos/explorer/discovery-snapshot';

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

void test('a run reads a small index whole, at the largest page size, and its snapshot shows it', async () => {
  const { requests } = fakeIndex({ models: { a: ['n1', 'n2'], b: ['n2'] } });
  const { stored, problems } = await readIndex(null, () => 100);
  assert.deepEqual(problems, []);
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
  assert.equal(snapshot.datedAt, null);
  assert.deepEqual(shownNodes(stored, 100), ['n1', 'n2']);
  assert.ok(snapshot.sellers.every((seller) => seller.uptime));
  assert.ok(snapshot.network);
  assert.equal(snapshot.generatedAt, 7);
});

void test('seller pages are followed to the end within the run', async () => {
  const { requests } = fakeIndex({ models: { a: nodes('n', 5) }, perPage: 2 });
  const { stored } = await readIndex(null, () => 1);
  assert.equal(count(requests, '/sellers'), 3);
  assert.equal(shownNodes(stored, 1).length, 5);
});

void test('a catalog with more models than fit in a run is carried on and shown only once whole, dated from its start', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const models = { a: ['n1'], ...manyModels(DISCOVERY.maxRequestsPerRun) };
  const began = 2 * MINUTE;
  let now = 0;
  let runs = 0;
  do {
    now += 2 * MINUTE;
    runs += 1;
    const { requests } = fakeIndex({ models });
    ({ stored } = await readIndex(stored, () => now));
    assert.ok(requests.length <= DISCOVERY.maxRequestsPerRun);
    assert.ok(requests.every((request) => !request.includes('cursor')));
    if (stored.pending) assert.deepEqual(shownNodes(stored, now), ['n1']);
  } while (stored.pending);
  assert.ok(runs > 1);
  assert.equal(shownNodes(stored, now).length, Object.keys(models).length);
  assert.equal(stored.catalog?.readAt, began);
});

void test('a model whose pages do not all fit in the run is read again from its first page next run', async () => {
  const models = {
    ...manyModels(DISCOVERY.maxRequestsPerRun - 4),
    big: nodes('b', 5),
  };
  fakeIndex({ models, perPage: 2 });
  let { stored } = await readIndex(null, () => 0);
  assert.ok(stored.pending);
  const { requests } = fakeIndex({ models, perPage: 2 });
  ({ stored } = await readIndex(stored, () => 2 * MINUTE));
  const big = requests.filter((request) => request.includes('model=big'));
  assert.equal(big.length, 3);
  assert.ok(!big[0]?.includes('cursor'));
  assert.equal(stored.pending, null);
  assert.equal(
    shownNodes(stored, 2 * MINUTE).length,
    Object.keys(models).length + 4,
  );
});

void test('while a large catalog is read, a run still reads its share of due uptimes', async () => {
  fakeIndex({ models: { a: nodes('n', 20) } });
  let { stored } = await readIndex(null, () => 0);
  assert.ok(snapshotOf(stored, 0).sellers.every((seller) => seller.uptime));
  const { requests } = fakeIndex({
    models: { a: nodes('n', 20), ...manyModels(DISCOVERY.maxRequestsPerRun) },
  });
  ({ stored } = await readIndex(stored, () => DISCOVERY.uptimeRefreshMs));
  assert.ok(stored.pending);
  assert.equal(requests.length, DISCOVERY.maxRequestsPerRun);
  assert.equal(count(requests, '/uptime'), DISCOVERY.reservedUptimes);
});

void test('a later page that fails ends the run’s catalog reading; the model is read again from its first page', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const grown = { a: ['n1'], b: nodes('p', 5) };
  let index = fakeIndex({
    models: grown,
    perPage: 2,
    failSellers: new Set(['b']),
    failLaterPages: true,
  });
  let problems;
  ({ stored, problems } = await readIndex(stored, () => 2 * MINUTE));
  assert.deepEqual(problems, ['sellers']);
  assert.ok(stored.pending);
  assert.equal(count(index.requests, 'model=b'), 2);
  assert.deepEqual(shownNodes(stored, 2 * MINUTE), ['n1']);

  index = fakeIndex({ models: grown, perPage: 2 });
  ({ stored } = await readIndex(stored, () => 4 * MINUTE));
  const again = index.requests.filter((request) => request.includes('model=b'));
  assert.ok(!again[0]?.includes('cursor'));
  assert.equal(stored.pending, null);
  assert.equal(shownNodes(stored, 4 * MINUTE).length, 6);
});

void test('a catalog read that never ends begins again, says so, and the last whole catalog stays shown', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const broken = {
    models: { a: ['n1'], b: ['n2'] },
    failSellers: new Set(['b']),
  };
  fakeIndex(broken);
  ({ stored } = await readIndex(stored, () => MINUTE));
  const began = stored.pending?.startedAt;
  fakeIndex(broken);
  ({ stored } = await readIndex(stored, () => 2 * MINUTE));
  assert.equal(stored.pending?.startedAt, began);
  const later = MINUTE + DISCOVERY.restartAfterMs;
  const { requests } = fakeIndex(broken);
  let problems;
  ({ stored, problems } = await readIndex(stored, () => later));
  assert.ok(problems.includes('catalog-restarted'));
  assert.equal(count(requests, '/models'), 1);
  assert.equal(stored.pending?.startedAt, later);
  assert.deepEqual(shownNodes(stored, later), ['n1']);
  assert.equal(snapshotOf(stored, later).datedAt, 0);
});

void test('a malformed seller entry is skipped and reported; the rest of its page is read', async () => {
  fakeIndex({
    models: { a: ['n1', 'bad', 'n2'] },
    malformed: new Set(['bad']),
  });
  const { stored, problems } = await readIndex(null, () => 0);
  assert.deepEqual(problems, ['seller-record']);
  assert.deepEqual(shownNodes(stored, 0), ['n1', 'n2']);
});

void test('a shown catalog whose read began over an hour ago is dated, even with recent progress', () => {
  const stored: StoredDiscovery = {
    progressAt: DISCOVERY.restartAfterMs + 1,
    catalog: {
      readAt: 0,
      generatedAt: 1,
      network: null,
      networkReadAt: null,
      sellers: [],
    },
    pending: null,
    uptimes: {},
  };
  assert.equal(snapshotOf(stored, DISCOVERY.restartAfterMs).datedAt, null);
  assert.equal(snapshotOf(stored, DISCOVERY.restartAfterMs + 1).datedAt, 0);
});

void test('no request begins after the run’s deadline', async () => {
  fakeIndex({ models: manyModels(DISCOVERY.maxRequestsPerRun) });
  // Every request takes a tenth of the deadline; record when each one begins.
  let now = 0;
  const began: number[] = [];
  const answer = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    began.push(now);
    now += DISCOVERY.runDeadlineMs / 10;
    return answer(input);
  }) as typeof fetch;
  await readIndex(null, () => now);
  assert.ok(began.length > 0);
  assert.ok(began.every((at) => at < DISCOVERY.runDeadlineMs));
});

void test('no uptime try begins after the run’s deadline either', async () => {
  const sellers = nodes('n', 60);
  fakeIndex({ models: { a: sellers } });
  let { stored } = await readIndex(null, () => 0);
  let now = DISCOVERY.uptimeRefreshMs;
  const began: number[] = [];
  fakeIndex({ models: { a: sellers } });
  const answer = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    began.push(now - DISCOVERY.uptimeRefreshMs);
    now += DISCOVERY.runDeadlineMs / 10;
    return answer(input);
  }) as typeof fetch;
  ({ stored } = await readIndex(stored, () => now));
  assert.ok(began.length > 0);
  assert.ok(began.every((at) => at < DISCOVERY.runDeadlineMs));
});

void test('slow uptimes leave the run time for its catalog reading', async () => {
  const sellers = nodes('n', 30);
  fakeIndex({ models: { a: sellers } });
  let { stored } = await readIndex(null, () => 0);
  let now = DISCOVERY.uptimeRefreshMs;
  const { requests } = fakeIndex({ models: { a: [...sellers, 'new'] } });
  const answer = globalThis.fetch;
  // Each /uptime advances the clock a sixth of the fetch timeout (six run at once); other answers are
  // instant.
  globalThis.fetch = ((input: string | URL | Request) => {
    if (String(input).includes('/uptime')) now += FETCH.timeoutMs / 6;
    return answer(input);
  }) as typeof fetch;
  ({ stored } = await readIndex(stored, () => now));
  assert.ok(count(requests, '/sellers') > 0);
  assert.equal(stored.pending, null);
  assert.ok(shownNodes(stored, now).includes('new'));
});

void test('a catalog read over several runs is not dated while it advances, and is once it stops', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const models = { a: ['n1'], ...manyModels(4 * DISCOVERY.maxRequestsPerRun) };
  let now = 0;
  for (let run = 0; run < 4; run += 1) {
    now += 2 * MINUTE;
    fakeIndex({ models });
    ({ stored } = await readIndex(stored, () => now));
    assert.equal(snapshotOf(stored, now).datedAt, null);
  }
  assert.ok(stored.pending);
  fakeIndex({ models, down: true });
  ({ stored } = await readIndex(stored, () => now + 2 * MINUTE));
  const late = now + DISCOVERY.staleAfterMs + MINUTE;
  assert.equal(snapshotOf(stored, late).datedAt, stored.catalog?.readAt);
});

void test('uptimes are tried in turns, never-tried first, a few at a time, and again only once old', async () => {
  const sellers = nodes('n', 100);
  let now = 0;
  let index = fakeIndex({ models: { a: sellers }, uptimeDelayMs: 1 });
  let { stored } = await readIndex(null, () => now);
  assert.equal(index.requests.length, DISCOVERY.maxRequestsPerRun);
  assert.ok(index.uptimes.most > 1);
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
      assert.ok(!seen.has(nodeId ?? ''), 'a never-tried uptime comes first');
      seen.add(nodeId ?? '');
    }
  }
  assert.ok(snapshotOf(stored, now).sellers.every((seller) => seller.uptime));

  now = DISCOVERY.uptimeRefreshMs;
  index = fakeIndex({ models: { a: sellers } });
  ({ stored } = await readIndex(stored, () => now));
  assert.deepEqual(uptimeNodes(index.requests), firstRead);
});

void test('a failed uptime keeps the last one and waits its turn; an uptime goes only with its seller', async () => {
  fakeIndex({ models: { a: ['n1', 'n2'] } });
  let { stored } = await readIndex(null, () => 0);
  const later = DISCOVERY.uptimeRefreshMs;
  fakeIndex({ models: { a: ['n1', 'n2'] }, failUptime: new Set(['n1']) });
  let problems;
  ({ stored, problems } = await readIndex(stored, () => later));
  assert.deepEqual(problems, ['uptime']);
  assert.equal(stored.uptimes.n1?.triedAt, later);
  assert.ok(snapshotOf(stored, later).sellers[0]?.uptime);
  // Not tried again in the next run.
  const { requests } = fakeIndex({ models: { a: ['n1', 'n2'] } });
  ({ stored } = await readIndex(stored, () => later + 2 * MINUTE));
  assert.equal(count(requests, '/uptime'), 0);

  fakeIndex({ models: { a: ['n1'] } });
  ({ stored } = await readIndex(stored, () => later + 4 * MINUTE));
  assert.ok(stored.uptimes.n1);
  assert.equal(stored.uptimes.n2, undefined);
});

void test('an uptime whose tries keep failing is no longer shown once a day old', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  fakeIndex({ models: { a: ['n1'] }, failUptime: new Set(['n1']) });
  ({ stored } = await readIndex(stored, () => DISCOVERY.uptimeMaxAgeMs));
  assert.ok(snapshotOf(stored, DISCOVERY.uptimeMaxAgeMs).sellers[0]?.uptime);
  const after = DISCOVERY.uptimeMaxAgeMs + 1;
  assert.equal(snapshotOf(stored, after).sellers[0]?.uptime, null);
});

void test('a failed or malformed /network answer keeps the last one, dated; an index without it has none', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  let { stored } = await readIndex(null, () => 0);
  const last = snapshotOf(stored, 0).network;
  assert.ok(last);
  assert.equal(snapshotOf(stored, 0).networkDatedAt, null);
  fakeIndex({ models: { a: ['n1'] }, offline: 'malformed' });
  let problems;
  ({ stored, problems } = await readIndex(stored, () => 2 * MINUTE));
  assert.deepEqual(problems, ['network']);
  const kept = snapshotOf(stored, 2 * MINUTE);
  assert.deepEqual(kept.network, last);
  assert.equal(kept.networkDatedAt, 0);
  assert.equal(snapshotOf(stored, 2 * MINUTE).datedAt, null);

  fakeIndex({ models: { a: ['n1'] }, offline: null });
  const fresh = await readIndex(null, () => 0);
  assert.equal(snapshotOf(fresh.stored, 0).network, null);
  assert.deepEqual(shownNodes(fresh.stored, 0), ['n1']);
});
