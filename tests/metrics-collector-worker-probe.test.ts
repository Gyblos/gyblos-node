// Protects the deployed entry's RPC probe: the worker serves it only through the app, so plain http is
// refused before the token is read, a refused per-address limit answers 429, and an authorized https
// call answers with the app's no-store header. Fake bindings and a stubbed fetch only; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLECTOR_ADMIN_TOKEN_BINDING,
  COLLECTOR_DB_BINDING,
  COLLECTOR_LIMITERS,
  COLLECTOR_ROUTES,
} from '@gyblos/metrics-collector/constants';
import worker from '@gyblos/metrics-collector/worker';

const TOKEN = 'a'.repeat(40);
const context = { waitUntil() {} };

function bindings(allow: boolean) {
  const limiter = { limit: () => Promise.resolve({ success: allow }) };
  return {
    // Only its shape is read: the probe never touches storage.
    [COLLECTOR_DB_BINDING]: { prepare() {}, batch() {} },
    ...Object.fromEntries(
      Object.values(COLLECTOR_LIMITERS).map((name) => [name, limiter]),
    ),
    [COLLECTOR_ADMIN_TOKEN_BINDING]: TOKEN,
  };
}
const probe = (origin: string) =>
  new Request(`${origin}${COLLECTOR_ROUTES.RPC_PROBE}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'cf-connecting-ip': '203.0.113.7',
    },
  });

void test('the worker serves the probe only behind the app: https, the limit and no-store', async () => {
  const realFetch = globalThis.fetch;
  // Every endpoint refuses, so the probe answers without the network.
  globalThis.fetch = (async () =>
    new Response('no', { status: 403 })) as typeof fetch;
  try {
    const insecure = await worker.fetch(
      probe('http://collector.test'),
      bindings(true),
      context,
    );
    assert.equal(insecure.status, 400);
    const limited = await worker.fetch(
      probe('https://collector.test'),
      bindings(false),
      context,
    );
    assert.equal(limited.status, 429);
    const answered = await worker.fetch(
      probe('https://collector.test'),
      bindings(true),
      context,
    );
    assert.equal(answered.status, 200);
    assert.equal(answered.headers.get('cache-control'), 'no-store');
    assert.equal(answered.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    globalThis.fetch = realFetch;
  }
});
