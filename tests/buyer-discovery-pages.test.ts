import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverBuyerSellers } from '@gyblos/buyer/discovery';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery';

const node = (byte: number) =>
  byte.toString(16).padStart(2, '0').padEnd(64, '0');
const INDEX = Array.from({ length: 12 }, (_, i) => node((i + 1) * 20));

function pagedIndex(pageSize: number) {
  const cursors: (string | null)[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const cursor = url.searchParams.get('cursor');
    cursors.push(cursor);
    const rest = INDEX.filter((id) => cursor === null || id > cursor);
    const page = rest.slice(0, pageSize);
    return discoveryResponse([], rest.length > pageSize ? page.at(-1)! : null);
  };
  return { cursors, fetch };
}

void test('past the page ceiling the buyer rereads from a random NodeId and wraps around', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const index = pagedIndex(2);
    await discoverBuyerSellers(
      { ...run.config, discovery: { ...run.config.discovery, maxPages: 4 } },
      home.state,
      { fetch: index.fetch, now: run.context.now, random: () => 0.5 },
    );
    const start = '80000000'.padEnd(64, '0');
    assert.deepEqual(index.cursors, [
      null,
      node(40),
      node(80),
      node(120),
      start,
      node(160),
      node(200),
      null,
    ]);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('an index within the page ceiling is read once from the start', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const index = pagedIndex(4);
    await discoverBuyerSellers(
      { ...run.config, discovery: { ...run.config.discovery, maxPages: 3 } },
      home.state,
      { fetch: index.fetch, now: run.context.now, random: () => 0.5 },
    );
    assert.deepEqual(index.cursors, [null, node(80), node(160)]);
  } finally {
    await run.wire.close();
    await home.close();
  }
});
