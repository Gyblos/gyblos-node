// Protects the discovery client against replayed and duplicated index entries: per-page NodeId
// deduplication by sequence and the caller's optional high-water mark. Synthetic records, fake fetch only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_ERROR_CODES, fetchSellers } from '@gyblos/discovery-http';

import {
  DISCOVERY_BASE,
  DISCOVERY_NOW,
  discoverySeller,
  fakeFetch,
  jsonResponse,
  rejectsWith,
  sellersBody,
} from './support/discovery-fixture.js';

const MODEL = 'qwen3-0.6b';
const now = () => DISCOVERY_NOW;

void test('a repeated NodeId keeps the entry with the highest catalog sequence', async () => {
  const seller = await discoverySeller();
  const other = await discoverySeller();
  const newer = await seller.entryAt(3);
  const newest = await seller.entryAt(5);
  const entries = [seller.entry, other.entry, newest, newer, seller.entry];
  const { fetch } = fakeFetch(() => jsonResponse(200, sellersBody(entries)));
  const result = await fetchSellers({
    baseUrl: DISCOVERY_BASE,
    model: MODEL,
    fetch,
    now,
  });
  assert.deepEqual(
    result.sellers.map((entry) => [
      entry.catalog.nodeId,
      entry.catalog.sequence,
    ]),
    [
      [seller.catalog.nodeId, 5],
      [other.catalog.nodeId, 1],
    ],
  );
  assert.equal(result.sellers[0]!.presence.sequence, 6);
  assert.equal(result.dropped, 3);
});

void test('lastSequence drops entries at or below the caller high-water mark', async () => {
  const replayed = await discoverySeller();
  const equal = await discoverySeller();
  const fresh = await discoverySeller();
  const unknown = await discoverySeller();
  const known = new Map([
    [replayed.catalog.nodeId, 7],
    [equal.catalog.nodeId, 2],
    [fresh.catalog.nodeId, 1],
  ]);
  const asked: string[] = [];
  const entries = [replayed.entry, equal.entry, fresh.entry, unknown.entry];
  const { fetch } = fakeFetch(() => jsonResponse(200, sellersBody(entries)));
  const result = await fetchSellers({
    baseUrl: DISCOVERY_BASE,
    model: MODEL,
    fetch,
    now,
    lastSequence: (nodeId) => {
      asked.push(nodeId);
      return known.get(nodeId);
    },
  });
  assert.deepEqual(
    result.sellers.map((entry) => entry.catalog.nodeId),
    [fresh.catalog.nodeId, unknown.catalog.nodeId],
  );
  assert.equal(result.dropped, 2);
  assert.deepEqual(
    asked,
    entries.map((entry) => entry.catalog.record.nodeId),
  );
});

void test('an invalid lastSequence callback or value is refused as caller input', async () => {
  const seller = await discoverySeller();
  const base = { baseUrl: DISCOVERY_BASE, model: MODEL, now };
  const page = () => jsonResponse(200, sellersBody([seller.entry]));
  const notFunction = fakeFetch(page);
  await assert.rejects(
    fetchSellers({
      ...base,
      fetch: notFunction.fetch,
      lastSequence: 3 as never,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.INVALID_INPUT),
  );
  assert.equal(notFunction.calls.length, 0);
  for (const value of [-1, 1.5, Number.NaN, '2']) {
    const { fetch } = fakeFetch(page);
    await assert.rejects(
      fetchSellers({ ...base, fetch, lastSequence: () => value as never }),
      rejectsWith(DISCOVERY_ERROR_CODES.INVALID_INPUT),
    );
  }
});
