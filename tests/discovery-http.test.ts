// Protects the HTTP discovery client: local re-verification of untrusted index data, bounded reads,
// deadlines, safe URLs and static error codes. Synthetic records and a fake fetch only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  DISCOVERY_ERROR_CODES,
  fetchSellers,
  publishRecord,
  type DiscoveryErrorCode,
} from '@gyblos/discovery-http';
import { DISCOVERY_LIMITS } from '@gyblos/discovery-http/constants';

import {
  DISCOVERY_BASE,
  DISCOVERY_NOW,
  discoverySeller,
  endlessResponse,
  fakeFetch,
  forge,
  jsonResponse,
  rejectsWith,
  sellersBody,
} from './support/discovery-fixture.js';

const MODEL = 'qwen3-0.6b';
const now = () => DISCOVERY_NOW;

void test('the default index URL is the operator value from config', () => {
  assert.equal(DISCOVERY_INDEX_URL, 'https://gyblos.com/api/v1/discovery');
});

void test('fetchSellers returns verified sellers shaped for selectSellers', async () => {
  const first = await discoverySeller();
  const second = await discoverySeller();
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse(200, sellersBody([first.entry, second.entry])),
  );
  const result = await fetchSellers({
    baseUrl: DISCOVERY_BASE,
    model: MODEL,
    fetch,
    now,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${DISCOVERY_BASE}/sellers?model=qwen3-0.6b`);
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  assert.equal(result.dropped, 0);
  assert.equal(result.next, null);
  assert.equal(result.generatedAt, DISCOVERY_NOW);
  assert.deepEqual(result.sellers, [
    {
      catalog: first.catalog,
      presence: first.signedPresence.record,
      withdrawal: null,
    },
    {
      catalog: second.catalog,
      presence: second.signedPresence.record,
      withdrawal: null,
    },
  ]);
});

void test('forged, expired, mismatched, off-model and duplicate entries are dropped and counted', async () => {
  const good = await discoverySeller();
  const forged = await discoverySeller();
  const expired = await discoverySeller({ presenceLifetimeMs: 100 });
  const otherCatalog = await discoverySeller();
  const otherModel = await discoverySeller({ modelId: 'other-model' });
  const foreign = await discoverySeller();
  const replaced = await otherCatalog.presenceFor({
    ...otherCatalog.catalog,
    models: otherCatalog.catalog.models.map((listing) => ({
      ...listing,
      contextTokens: listing.contextTokens + 1,
    })),
  });
  const entries = [
    good.entry,
    { catalog: forge(forged.signedCatalog), presence: forged.signedPresence },
    { catalog: forged.signedCatalog, presence: forge(forged.signedPresence) },
    expired.entry,
    { catalog: otherCatalog.signedCatalog, presence: replaced },
    otherModel.entry,
    { catalog: good.signedCatalog, presence: foreign.signedPresence },
    good.entry,
    { catalog: good.signedCatalog },
    { ...good.entry, extra: true },
    'not-an-entry',
    { catalog: good.signedPresence, presence: good.signedPresence },
  ];
  const { fetch } = fakeFetch(() => jsonResponse(200, sellersBody(entries)));
  const result = await fetchSellers({
    baseUrl: DISCOVERY_BASE,
    model: MODEL,
    fetch,
    now,
  });
  assert.equal(result.sellers.length, 1);
  assert.equal(result.sellers[0]!.catalog.nodeId, good.catalog.nodeId);
  assert.equal(result.dropped, entries.length - 1);
});

void test('a catalog expired at now drops the seller', async () => {
  const seller = await discoverySeller();
  const { fetch } = fakeFetch(() =>
    jsonResponse(200, sellersBody([seller.entry])),
  );
  const result = await fetchSellers({
    baseUrl: DISCOVERY_BASE,
    model: MODEL,
    fetch,
    now: () => seller.catalog.expiresAt,
  });
  assert.deepEqual(result.sellers, []);
  assert.equal(result.dropped, 1);
});

void test('limit and cursor pass through encoded and next is returned', async () => {
  const seller = await discoverySeller();
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse(200, sellersBody([seller.entry], 'page-2.x~y')),
  );
  const result = await fetchSellers({
    baseUrl: `${DISCOVERY_BASE}/`,
    model: 'org/model:tag',
    fetch,
    now,
    limit: 2,
    cursor: 'abc_DEF-1.2~',
  });
  assert.equal(
    calls[0]!.url,
    `${DISCOVERY_BASE}/sellers?model=org%2Fmodel%3Atag&limit=2&cursor=abc_DEF-1.2~`,
  );
  assert.equal(result.next, 'page-2.x~y');
});

void test('more entries than the requested limit is a malformed response', async () => {
  const seller = await discoverySeller();
  const { fetch } = fakeFetch(() =>
    jsonResponse(200, sellersBody([seller.entry, seller.entry])),
  );
  await assert.rejects(
    fetchSellers({
      baseUrl: DISCOVERY_BASE,
      model: MODEL,
      fetch,
      now,
      limit: 1,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE),
  );
});

void test('malformed JSON and malformed page shapes are rejected with a static code', async () => {
  const bodies = [
    new Response('{"sellers": [', { status: 200 }),
    new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
    jsonResponse(200, []),
    jsonResponse(200, { sellers: [], next: null }),
    jsonResponse(200, { ...sellersBody([]), extra: 1 }),
    jsonResponse(200, { sellers: {}, next: null, generatedAt: 1 }),
    jsonResponse(200, { sellers: [], next: 'bad cursor', generatedAt: 1 }),
    jsonResponse(200, { sellers: [], next: null, generatedAt: -1 }),
    jsonResponse(200, { sellers: [], next: null, generatedAt: '1' }),
  ];
  for (const body of bodies) {
    const { fetch } = fakeFetch(() => body);
    await assert.rejects(
      fetchSellers({ baseUrl: DISCOVERY_BASE, model: MODEL, fetch, now }),
      rejectsWith(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE),
    );
  }
});

void test('an oversized body is rejected without buffering it fully', async () => {
  const chunkBytes = 64 * 1024;
  const endless = endlessResponse(chunkBytes);
  const { fetch } = fakeFetch(() => endless.response);
  await assert.rejects(
    fetchSellers({ baseUrl: DISCOVERY_BASE, model: MODEL, fetch, now }),
    rejectsWith(DISCOVERY_ERROR_CODES.RESPONSE_TOO_LARGE, 200),
  );
  const maxPulls =
    Math.ceil(DISCOVERY_LIMITS.maxSellersResponseBytes / chunkBytes) + 2;
  assert.ok(endless.pulls() <= maxPulls);
  let pulled = false;
  const declared = new Response(
    new ReadableStream(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 200, headers: { 'content-length': '999999999' } },
  );
  await assert.rejects(
    fetchSellers({
      baseUrl: DISCOVERY_BASE,
      model: MODEL,
      fetch: fakeFetch(() => declared).fetch,
      now,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.RESPONSE_TOO_LARGE),
  );
  assert.equal(pulled, false);
});

void test('non-2xx sellers responses map to static codes without reading the body', async () => {
  const cases: [number, DiscoveryErrorCode][] = [
    [400, DISCOVERY_ERROR_CODES.INVALID_QUERY],
    [429, DISCOVERY_ERROR_CODES.RATE_LIMITED],
    [503, DISCOVERY_ERROR_CODES.UNAVAILABLE],
    [500, DISCOVERY_ERROR_CODES.HTTP_STATUS],
    [404, DISCOVERY_ERROR_CODES.HTTP_STATUS],
    [204, DISCOVERY_ERROR_CODES.HTTP_STATUS],
  ];
  for (const [status, code] of cases) {
    const { fetch } = fakeFetch(() =>
      status === 204
        ? new Response(null, { status })
        : jsonResponse(status, { error: 'model qwen3-0.6b echoed' }),
    );
    await assert.rejects(
      fetchSellers({ baseUrl: DISCOVERY_BASE, model: MODEL, fetch, now }),
      (error: unknown) => {
        rejectsWith(code, status)(error);
        assert.ok(error instanceof Error && !error.message.includes(MODEL));
        return true;
      },
    );
  }
});

void test('network failures and deadlines map to static codes', async () => {
  const failing = async () => {
    throw new TypeError('fetch failed https://index.test');
  };
  await assert.rejects(
    fetchSellers({
      baseUrl: DISCOVERY_BASE,
      model: MODEL,
      fetch: failing,
      now,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.NETWORK),
  );
  const hanging = () => new Promise<Response>(() => {});
  await assert.rejects(
    fetchSellers({
      baseUrl: DISCOVERY_BASE,
      model: MODEL,
      fetch: hanging,
      now,
      timeoutMs: 20,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.TIMEOUT),
  );
  let signal: AbortSignal | null | undefined;
  const stalled = async (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Response(new ReadableStream({ pull() {} }), { status: 200 });
  };
  await assert.rejects(
    publishRecord({
      baseUrl: DISCOVERY_BASE,
      record: (await discoverySeller()).signedCatalog,
      fetch: async (url, init) => {
        const response = await stalled(url, init);
        return new Response(response.body, { status: 201 });
      },
      timeoutMs: 20,
    }),
    rejectsWith(DISCOVERY_ERROR_CODES.TIMEOUT),
  );
  assert.equal(signal?.aborted, true);
});

void test('base URLs must be https except loopback, without credentials or query', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, sellersBody([])));
  const insecure = [
    'http://index.test/api',
    'ftp://index.test/',
    'file:///etc/passwd',
  ];
  for (const baseUrl of insecure)
    await assert.rejects(
      fetchSellers({ baseUrl, model: MODEL, fetch, now }),
      rejectsWith(DISCOVERY_ERROR_CODES.INSECURE_URL),
    );
  const invalid = [
    'not a url',
    'https://user:secret@index.test/',
    'https://index.test/?a=1',
    'https://index.test/#x',
  ];
  for (const baseUrl of invalid)
    await assert.rejects(
      fetchSellers({ baseUrl, model: MODEL, fetch, now }),
      (error: unknown) => {
        rejectsWith(DISCOVERY_ERROR_CODES.INVALID_INPUT)(error);
        assert.ok(error instanceof Error && !error.message.includes('secret'));
        return true;
      },
    );
  assert.equal(calls.length, 0);
  for (const baseUrl of [
    'http://127.0.0.1:8787/api/v1/discovery',
    'http://localhost:8787/api/v1/discovery',
    'http://[::1]:8787/api/v1/discovery',
  ])
    await fetchSellers({ baseUrl, model: MODEL, fetch, now });
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0]!.url,
    'http://127.0.0.1:8787/api/v1/discovery/sellers?model=qwen3-0.6b',
  );
});

void test('invalid model, limit, cursor and timeout inputs are refused before fetching', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, sellersBody([])));
  const base = { baseUrl: DISCOVERY_BASE, model: MODEL, fetch, now };
  const inputs = [
    { ...base, model: 'qwen&limit=999' },
    { ...base, model: '../records' },
    { ...base, model: 'x'.repeat(129) },
    { ...base, limit: 0 },
    { ...base, limit: 201 },
    { ...base, limit: 1.5 },
    { ...base, cursor: 'a/b' },
    { ...base, cursor: '' },
    { ...base, timeoutMs: 0 },
  ];
  for (const input of inputs)
    await assert.rejects(
      fetchSellers(input),
      rejectsWith(DISCOVERY_ERROR_CODES.INVALID_INPUT),
    );
  assert.equal(calls.length, 0);
});
