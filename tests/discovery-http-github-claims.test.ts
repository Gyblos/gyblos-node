// The discovery client's GitHub claim calls: POST /identity/github answers are shape-checked (retryAfter
// only with CHECK_DEFERRED) and refusals mapped to static codes; GET /identity/github/<nodeId> reads one
// view or null. Fake fetch; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  fetchGithubClaim,
  submitGithubClaim,
} from '@gyblos/discovery-http';
import type { SignedIdentityClaim } from '@gyblos/protocol/identity-claim';

const BASE = 'https://discovery.gyblos.com/v1';
const NODE = 'ab'.repeat(32);
const SIGNED: SignedIdentityClaim = {
  claim: {
    schemaVersion: 1,
    kind: 'github',
    nodeId: NODE,
    account: 'octo-cat',
    gist: '0123456789abcdef0123456789abcdef',
    issuedAt: 1,
  },
  signature: '00'.repeat(64),
};
const reply = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DiscoveryError);
    return error.code;
  }
  return assert.fail('expected a DiscoveryError');
}

void test('a claim answer is read with its state, reason and a CHECK_DEFERRED retryAfter', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const answer = await submitGithubClaim({
    baseUrl: BASE,
    signed: SIGNED,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response(
        JSON.stringify({
          ok: true,
          state: 'pending',
          reason: 'CHECK_DEFERRED',
          retryAfter: 42,
        }),
      );
    },
  });
  assert.deepEqual(answer, {
    state: 'pending',
    reason: 'CHECK_DEFERRED',
    retryAfter: 42,
  });
  assert.equal(sent[0]?.url, `${BASE}/identity/github`);
  assert.equal(sent[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent[0]?.init.body)), SIGNED);
  assert.deepEqual(
    await submitGithubClaim({
      baseUrl: BASE,
      signed: SIGNED,
      fetch: reply(200, { ok: true, state: null, reason: null }),
    }),
    { state: null, reason: null },
  );
});

void test('claim refusals and malformed answers map to static codes', async () => {
  const cases: [number, unknown, string][] = [
    [400, { error: 'INVALID_CLAIM' }, DISCOVERY_ERROR_CODES.CLAIM_REJECTED],
    [
      400,
      { error: 'INVALID_SIGNATURE' },
      DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    ],
    [403, { error: 'UNKNOWN_NODE' }, DISCOVERY_ERROR_CODES.UNKNOWN_NODE],
    [409, { error: 'STALE_CLAIM' }, DISCOVERY_ERROR_CODES.STALE_CLAIM],
    [429, { error: 'RATE_LIMITED' }, DISCOVERY_ERROR_CODES.RATE_LIMITED],
    [
      503,
      { error: 'DISCOVERY_UNAVAILABLE' },
      DISCOVERY_ERROR_CODES.UNAVAILABLE,
    ],
    [404, { error: 'NOT_FOUND' }, DISCOVERY_ERROR_CODES.HTTP_STATUS],
    [
      200,
      { ok: true, state: 'gone', reason: null },
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    ],
    [
      200,
      { ok: true, state: 'verified', reason: null, retryAfter: 5 },
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    ],
    [
      200,
      { ok: true, state: 'pending', reason: 'CHECK_DEFERRED', retryAfter: 0 },
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    ],
  ];
  for (const [status, body, expected] of cases)
    assert.equal(
      await code(
        submitGithubClaim({
          baseUrl: BASE,
          signed: SIGNED,
          fetch: reply(status, body),
        }),
      ),
      expected,
      JSON.stringify(body),
    );
});

void test('a claim view is read back, 404 is none, and a foreign or malformed view is refused', async () => {
  const view = {
    nodeId: NODE,
    account: 'octo-cat',
    gist: SIGNED.claim.gist,
    state: 'lost',
    reason: 'GIST_NOT_FOUND',
    checkedAt: 5,
    verifiedAt: 1,
    issuedAt: SIGNED.claim.issuedAt,
    signature: SIGNED.signature,
  };
  const urls: string[] = [];
  assert.deepEqual(
    await fetchGithubClaim({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(view));
      },
    }),
    view,
  );
  assert.deepEqual(urls, [`${BASE}/identity/github/${NODE}`]);
  assert.deepEqual(
    await fetchGithubClaim({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: reply(200, { ...view, signature: null }),
    }),
    { ...view, signature: null },
  );
  const { issuedAt: _issuedAt, signature: _signature, ...older } = view;
  assert.deepEqual(
    await fetchGithubClaim({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: reply(200, older),
    }),
    { ...older, issuedAt: null, signature: null },
  );
  assert.equal(
    await fetchGithubClaim({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: reply(404, { error: 'NOT_FOUND' }),
    }),
    null,
  );
  for (const body of [
    { ...view, nodeId: 'cd'.repeat(32) },
    { ...view, state: 'odd' },
    { ...view, extra: 1 },
    { ...view, issuedAt: null },
    { ...view, issuedAt: undefined },
    { ...view, signature: 'AB'.repeat(64) },
    { ...view, signature: 'ab'.repeat(63) },
    // Terminal control data and newlines in index fields never reach the caller.
    { ...view, account: 'octo\u001b[2Jcat' },
    { ...view, account: 'octo\ncat' },
    { ...view, account: `a${'-b'.repeat(38)}` },
    { ...view, gist: 'ABCDEF0123456789ABCD' },
    { ...view, gist: `${'a'.repeat(32)}\n` },
    { ...view, gist: 'a'.repeat(33) },
  ])
    assert.equal(
      await code(
        fetchGithubClaim({
          baseUrl: BASE,
          nodeId: NODE,
          fetch: reply(200, body),
        }),
      ),
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    );
  assert.equal(
    await code(
      fetchGithubClaim({
        baseUrl: BASE,
        nodeId: 'AB',
        fetch: reply(200, view),
      }),
    ),
    DISCOVERY_ERROR_CODES.INVALID_INPUT,
  );
});
