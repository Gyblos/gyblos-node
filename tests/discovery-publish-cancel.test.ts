// Verifies caller cancellation reaches header and body waits for publication, including rejection bodies.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  publishRecord,
} from '@gyblos/discovery-http';

import {
  DISCOVERY_BASE,
  discoverySeller,
} from './support/discovery-fixture.js';

void test('publish caller cancellation cuts off stalled success and rejection bodies, and an already aborted call never fetches', async () => {
  const source = await discoverySeller();
  for (const status of [201, 400]) {
    const controller = new AbortController();
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const work = publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: source.entry.catalog,
      timeoutMs: 30,
      signal: controller.signal,
      fetch: async () => {
        started();
        return new Response(new ReadableStream({ start() {} }), { status });
      },
    });
    await ready;
    controller.abort();
    await assert.rejects(
      work,
      (error) =>
        error instanceof DiscoveryError &&
        error.code === DISCOVERY_ERROR_CODES.CANCELLED,
    );
  }
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;
  await assert.rejects(
    publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: source.entry.catalog,
      signal: controller.signal,
      fetch: async () => {
        fetches++;
        return new Response('{}');
      },
    }),
  );
  assert.equal(fetches, 0);
});
