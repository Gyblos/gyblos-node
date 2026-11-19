// Protects the explorer's reads of the discovery index, whose answers are not cached: one render reads
// a bounded number of seller pages and uptimes, says when it stopped short, and every read has a
// timeout so a slow source cannot hold a render.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import { getDiscovery } from '@gyblos/explorer/discovery';
import { fetchJson } from '@gyblos/explorer/fetch-json';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A fake index with `models` models, each listing one page of one distinct seller.
function fakeIndex(models: number, paths: string[]) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const json = (body: unknown) => Response.json(body);
    if (url.pathname.endsWith('/models'))
      return json({
        generatedAt: 1,
        models: Array.from({ length: models }, (_, index) => ({
          id: `m${index}`,
        })),
      });
    if (url.pathname.endsWith('/sellers')) {
      const model = url.searchParams.get('model') ?? '';
      return json({
        sellers: [
          {
            catalog: {
              record: { nodeId: `n-${model}`, owner: 'o', models: [] },
            },
          },
        ],
        next: null,
      });
    }
    if (url.pathname.endsWith('/uptime'))
      return json({ firstSeenAt: 1, windows: [] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

void test('a small index is read whole', async () => {
  const paths: string[] = [];
  fakeIndex(3, paths);
  const snapshot = await getDiscovery();
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.sellers.length, 3);
  assert.ok(snapshot.sellers.every((seller) => seller.uptime));
});

void test('a large index is read within the bounds and marked incomplete', async () => {
  const paths: string[] = [];
  fakeIndex(DISCOVERY.maxSellerPages + 5, paths);
  const snapshot = await getDiscovery();
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.truncated, true);
  assert.equal(
    paths.filter((path) => path.endsWith('/sellers')).length,
    DISCOVERY.maxSellerPages,
  );
  assert.ok(
    paths.filter((path) => path.endsWith('/uptime')).length <=
      DISCOVERY.maxUptimeReads,
  );
});

void test('every source read carries a timeout', async () => {
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    signal = init?.signal;
    return Response.json({});
  }) as typeof fetch;
  await fetchJson('https://source.test/x', 'test');
  assert.ok(signal instanceof AbortSignal);
});
