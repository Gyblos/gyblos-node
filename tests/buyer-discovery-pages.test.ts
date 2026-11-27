import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { readIndexPages } from '@gyblos/buyer/discovery-pages';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery';

const node = (byte: number) =>
  byte.toString(16).padStart(2, '0').padEnd(64, '0');
const TWELVE = Array.from({ length: 12 }, (_, i) => node((i + 1) * 20));
const HALF = () => 0.5;

function pagedIndex(ids: string[], pageSize: number) {
  const cursors: (string | undefined)[] = [];
  const read = async (cursor: string | undefined) => {
    cursors.push(cursor);
    const rest = ids.filter((id) => cursor === undefined || id > cursor);
    const page = rest.slice(0, pageSize);
    return {
      sellers: page.map((nodeId) => ({ catalog: { nodeId } })),
      next: rest.length > pageSize ? page.at(-1)! : null,
    };
  };
  return { cursors, read };
}
const ids = (entries: { catalog: { nodeId: string } }[]) =>
  entries.map((entry) => entry.catalog.nodeId);

void test('an index of one page is read once', async () => {
  const index = pagedIndex(TWELVE, 20);
  assert.deepEqual(ids(await readIndexPages(index.read, 8, HALF)), TWELVE);
  assert.equal(index.cursors.length, 1);
});

void test('an index within the page ceiling is covered once, without duplicates, in at most one extra read', async () => {
  const index = pagedIndex(TWELVE, 2);
  const seen = ids(await readIndexPages(index.read, 6, HALF));
  assert.deepEqual([...seen].sort(), TWELVE);
  const early = pagedIndex(TWELVE, 2);
  const fromStart = ids(await readIndexPages(early.read, 6, () => 0));
  assert.deepEqual([...fromStart].sort(), TWELVE);
  assert.ok(index.cursors.length <= 7);
});

void test('past the page ceiling the window starts at a random NodeId and wraps', async () => {
  const index = pagedIndex(TWELVE, 2);
  const seen = ids(await readIndexPages(index.read, 3, HALF));
  assert.deepEqual(seen, [...TWELVE.slice(0, 2), ...TWELVE.slice(6, 12)]);
  assert.equal(index.cursors[1], '80000000'.padEnd(64, '0'));
  assert.ok(index.cursors.length <= 4);
  const late = pagedIndex(TWELVE, 2);
  const wrapped = ids(await readIndexPages(late.read, 3, () => 0.9));
  assert.deepEqual(wrapped, [
    ...TWELVE.slice(0, 2),
    ...TWELVE.slice(11),
    ...TWELVE.slice(2, 6),
  ]);
});

void test('reading never asks the index for a page chosen by a seller this buyer used', async () => {
  const index = pagedIndex(TWELVE, 2);
  await readIndexPages(index.read, 3, HALF);
  const seeks = index.cursors.filter(
    (cursor) => cursor !== undefined && !TWELVE.includes(cursor),
  );
  assert.deepEqual(seeks, ['80000000'.padEnd(64, '0')]);
});

void test('a cursor cycle in any pass fails closed', async () => {
  await assert.rejects(
    readIndexPages(async () => ({ sellers: [], next: node(10) }), 4, HALF),
    { code: BUYER_SELECTION_CODES.DISCOVERY_LIMIT },
  );
});

void test('discovery passes the index cursors through to the index', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const cursors: (string | null)[] = [];
    await discoverBuyerSellers(
      { ...run.config, discovery: { ...run.config.discovery, maxPages: 2 } },
      home.state,
      {
        fetch: async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input);
          const cursor = url.searchParams.get('cursor');
          cursors.push(cursor);
          return discoveryResponse([], cursor === null ? node(40) : null);
        },
        now: run.context.now,
        random: HALF,
      },
    );
    assert.deepEqual(cursors, [null, '80000000'.padEnd(64, '0'), node(40)]);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('an index with opaque cursors is read in order up to the ceiling without failing', async () => {
  const pages = [[node(20)], [node(40)], [node(60)]];
  const cursors: (string | undefined)[] = [];
  const seen = ids(
    await readIndexPages(
      async (cursor) => {
        cursors.push(cursor);
        const index = Number(cursor ?? 0);
        return {
          sellers: pages[index]!.map((nodeId) => ({ catalog: { nodeId } })),
          next: index + 1 < pages.length ? String(index + 1) : null,
        };
      },
      2,
      HALF,
    ),
  );
  assert.deepEqual(seen, [node(20), node(40)]);
  assert.deepEqual(cursors, [undefined, '1']);
});

void test('a random pass whose page points back to its start fails closed', async () => {
  const start = '80000000'.padEnd(64, '0');
  await assert.rejects(
    readIndexPages(
      async (cursor) => ({
        sellers: [],
        next: cursor === undefined ? node(10) : start,
      }),
      4,
      HALF,
    ),
    { code: BUYER_SELECTION_CODES.DISCOVERY_LIMIT },
  );
});
