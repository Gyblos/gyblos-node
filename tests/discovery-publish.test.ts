// Protects the HTTP discovery client's publish path and its injected-fetch rule: exact bodies,
// static rejection codes and pre-fetch refusals. Synthetic records and a fake fetch only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOVERY_ERROR_CODES,
  fetchSellers,
  publishRecord,
  type DiscoveryErrorCode,
} from '@gyblos/discovery-http';

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

void test('the client never uses the global fetch', async () => {
  const original = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls++;
    throw new Error('global fetch used');
  };
  try {
    const seller = await discoverySeller();
    const sellers = fakeFetch(() =>
      jsonResponse(200, sellersBody([seller.entry])),
    );
    await fetchSellers({
      baseUrl: DISCOVERY_BASE,
      model: MODEL,
      fetch: sellers.fetch,
      now,
    });
    const published = fakeFetch(() => jsonResponse(201, { ok: true }));
    await publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: seller.signedCatalog,
      fetch: published.fetch,
    });
    assert.equal(sellers.calls.length, 1);
    assert.equal(published.calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(globalCalls, 0);
});

void test('publishRecord posts exactly the signed record and accepts 201', async () => {
  const seller = await discoverySeller();
  const { fetch, calls } = fakeFetch(() => jsonResponse(201, { ok: true }));
  assert.deepEqual(
    await publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: seller.signedPresence,
      fetch,
    }),
    { ok: true },
  );
  assert.equal(calls[0]!.url, `${DISCOVERY_BASE}/records`);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    record: seller.signedPresence,
  });
});

void test('publishRecord maps index rejections and statuses to static codes', async () => {
  const seller = await discoverySeller();
  const cases: [number, unknown, DiscoveryErrorCode][] = [
    [400, { error: 'INVALID_RECORD' }, DISCOVERY_ERROR_CODES.INVALID_RECORD],
    [
      400,
      { error: 'INVALID_SIGNATURE' },
      DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    ],
    [400, { error: 'EXPIRED_RECORD' }, DISCOVERY_ERROR_CODES.EXPIRED_RECORD],
    [400, { error: 'UNKNOWN_CATALOG' }, DISCOVERY_ERROR_CODES.UNKNOWN_CATALOG],
    [400, { error: 'STALE_RECORD' }, DISCOVERY_ERROR_CODES.STALE_RECORD],
    [400, { error: 'HTTPS_REQUIRED' }, DISCOVERY_ERROR_CODES.INSECURE_URL],
    [400, { error: 'SOMETHING_NEW' }, DISCOVERY_ERROR_CODES.RECORD_REJECTED],
    [
      400,
      { error: 'INVALID_RECORD', extra: 1 },
      DISCOVERY_ERROR_CODES.RECORD_REJECTED,
    ],
    [400, 'not json', DISCOVERY_ERROR_CODES.RECORD_REJECTED],
    [409, { error: 'STALE_RECORD' }, DISCOVERY_ERROR_CODES.STALE_RECORD],
    [413, {}, DISCOVERY_ERROR_CODES.PAYLOAD_TOO_LARGE],
    [429, {}, DISCOVERY_ERROR_CODES.RATE_LIMITED],
    [
      403,
      { error: 'PUBLISH_NOT_ALLOWED' },
      DISCOVERY_ERROR_CODES.PUBLISH_NOT_ALLOWED,
    ],
    [403, 'not json', DISCOVERY_ERROR_CODES.PUBLISH_NOT_ALLOWED],
    [
      503,
      { error: 'DISCOVERY_UNAVAILABLE' },
      DISCOVERY_ERROR_CODES.UNAVAILABLE,
    ],
    [500, {}, DISCOVERY_ERROR_CODES.HTTP_STATUS],
    [200, { ok: true }, DISCOVERY_ERROR_CODES.HTTP_STATUS],
    [201, { ok: false }, DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE],
    [201, { ok: true, id: 1 }, DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE],
  ];
  for (const [status, body, code] of cases) {
    const { fetch } = fakeFetch(() =>
      typeof body === 'string'
        ? new Response(`<${body}>`, { status })
        : jsonResponse(status, body),
    );
    await assert.rejects(
      publishRecord({
        baseUrl: DISCOVERY_BASE,
        record: seller.signedCatalog,
        fetch,
      }),
      rejectsWith(code, status),
    );
  }
});

void test('publishRecord refuses oversized or malformed records and insecure URLs before fetching', async () => {
  const seller = await discoverySeller();
  const { fetch, calls } = fakeFetch(() => jsonResponse(201, { ok: true }));
  const oversized = { ...seller.signedCatalog, signature: 'f'.repeat(35_000) };
  await assert.rejects(
    publishRecord({ baseUrl: DISCOVERY_BASE, record: oversized, fetch }),
    rejectsWith(DISCOVERY_ERROR_CODES.PAYLOAD_TOO_LARGE),
  );
  await assert.rejects(
    publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: { ...seller.signedCatalog, extra: 1 } as never,
      fetch,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.INVALID_INPUT),
  );
  await assert.rejects(
    publishRecord({
      baseUrl: 'http://index.test/api/v1/discovery',
      record: seller.signedCatalog,
      fetch,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.INSECURE_URL),
  );
  assert.equal(calls.length, 0);
});

void test('publishRecord accepts a valid 64-model catalog above 16 KiB', async () => {
  const seller = await discoverySeller();
  const record = await seller.largeCatalog(64);
  const { fetch, calls } = fakeFetch(() => jsonResponse(201, { ok: true }));
  assert.deepEqual(
    await publishRecord({ baseUrl: DISCOVERY_BASE, record, fetch }),
    { ok: true },
  );
  const bytes = new TextEncoder().encode(String(calls[0]!.init.body));
  assert.ok(bytes.byteLength > 20_000 && bytes.byteLength < 34_816);
});

void test('a deadline while reading a 400 body is a timeout, not a rejection', async () => {
  const seller = await discoverySeller();
  const stalled = async () =>
    new Response(new ReadableStream({ pull() {} }), { status: 400 });
  await assert.rejects(
    publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: seller.signedCatalog,
      fetch: stalled,
      timeoutMs: 20,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.TIMEOUT),
  );
});
