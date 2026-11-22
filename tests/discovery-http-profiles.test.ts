import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  fetchSellerProfile,
  submitSellerProfile,
} from '@gyblos/discovery-http';
import {
  PROFILE_CLAIM,
  type SignedProfileClaim,
} from '@gyblos/protocol/profile-claim';

const BASE = 'https://discovery.gyblos.com/v1';
const NODE = 'ab'.repeat(32);
const SIGNED: SignedProfileClaim = {
  claim: {
    schemaVersion: PROFILE_CLAIM.schemaVersion,
    nodeId: NODE,
    name: 'Ada Lovelace',
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

void test('a profile is posted as JSON and its answer read back', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const answer = await submitSellerProfile({
    baseUrl: BASE,
    signed: SIGNED,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ ok: true, name: 'Ada Lovelace' }));
    },
  });
  assert.deepEqual(answer, { name: 'Ada Lovelace' });
  assert.equal(sent[0]?.url, `${BASE}/profile`);
  assert.equal(sent[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent[0]?.init.body)), SIGNED);
  assert.deepEqual(
    await submitSellerProfile({
      baseUrl: BASE,
      signed: { ...SIGNED, claim: { ...SIGNED.claim, name: null } },
      fetch: reply(200, { ok: true, name: null }),
    }),
    { name: null },
  );
});

void test('profile refusals map to static codes', async () => {
  const cases: [number, unknown, string][] = [
    [400, { error: 'INVALID_CLAIM' }, DISCOVERY_ERROR_CODES.CLAIM_REJECTED],
    [
      400,
      { error: 'INVALID_SIGNATURE' },
      DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    ],
    [403, { error: 'UNKNOWN_NODE' }, DISCOVERY_ERROR_CODES.UNKNOWN_NODE],
    [403, { error: 'PROFILE_HELD' }, DISCOVERY_ERROR_CODES.PROFILE_HELD],
    [409, { error: 'STALE_CLAIM' }, DISCOVERY_ERROR_CODES.STALE_CLAIM],
    [413, {}, DISCOVERY_ERROR_CODES.PAYLOAD_TOO_LARGE],
    [429, {}, DISCOVERY_ERROR_CODES.RATE_LIMITED],
    [503, {}, DISCOVERY_ERROR_CODES.UNAVAILABLE],
    [404, {}, DISCOVERY_ERROR_CODES.HTTP_STATUS],
    [400, 'nope', DISCOVERY_ERROR_CODES.CLAIM_REJECTED],
  ];
  for (const [status, body, expected] of cases)
    assert.equal(
      await code(
        submitSellerProfile({
          baseUrl: BASE,
          signed: SIGNED,
          fetch: reply(status, body),
        }),
      ),
      expected,
      `${status} ${JSON.stringify(body)}`,
    );
});

void test('a profile answer or view with a name outside the rule is malformed', async () => {
  for (const body of [
    { ok: true, name: 'Ada ✓' },
    { ok: true, name: ' Ada' },
    { ok: true, name: `Ada${String.fromCodePoint(0x1b)}[31m` },
    { ok: true },
    { ok: false, name: null },
    { ok: true, name: null, extra: 1 },
  ])
    assert.equal(
      await code(
        submitSellerProfile({
          baseUrl: BASE,
          signed: SIGNED,
          fetch: reply(200, body),
        }),
      ),
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
      JSON.stringify(body),
    );
  const view = {
    nodeId: NODE,
    name: 'Ada Lovelace',
    issuedAt: 1,
    signature: 'cd'.repeat(64),
  };
  for (const body of [
    { ...view, name: 'Gyblos' },
    { ...view, name: null },
    { ...view, nodeId: 'cd'.repeat(32) },
    { ...view, issuedAt: -1 },
    { ...view, issuedAt: 8.64e15 + 1 },
    { ...view, issuedAt: Number.MAX_SAFE_INTEGER },
    { ...view, signature: 'xyz' },
    { ...view, extra: 1 },
  ])
    assert.equal(
      await code(
        fetchSellerProfile({
          baseUrl: BASE,
          nodeId: NODE,
          fetch: reply(200, body),
        }),
      ),
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
      JSON.stringify(body),
    );
});

void test('a profile is read back, a 404 is none and a bad NodeId is refused before fetching', async () => {
  const seen: string[] = [];
  const view = {
    nodeId: NODE,
    name: 'Ada Lovelace',
    issuedAt: 1,
    signature: 'cd'.repeat(64),
  };
  assert.deepEqual(
    await fetchSellerProfile({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify(view));
      },
    }),
    view,
  );
  assert.deepEqual(seen, [`${BASE}/profile/${NODE}`]);
  const latest = { ...view, issuedAt: 8.64e15 };
  assert.deepEqual(
    await fetchSellerProfile({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: reply(200, latest),
    }),
    latest,
  );
  assert.equal(
    await fetchSellerProfile({
      baseUrl: BASE,
      nodeId: NODE,
      fetch: reply(404, { error: 'NO_PROFILE' }),
    }),
    null,
  );
  for (const body of [{ error: 'NOT_FOUND' }, 'not json'])
    assert.equal(
      await code(
        fetchSellerProfile({
          baseUrl: BASE,
          nodeId: NODE,
          fetch: reply(404, body),
        }),
      ),
      DISCOVERY_ERROR_CODES.HTTP_STATUS,
    );
  assert.equal(
    await code(
      fetchSellerProfile({
        baseUrl: BASE,
        nodeId: NODE,
        fetch: reply(503, {}),
      }),
    ),
    DISCOVERY_ERROR_CODES.UNAVAILABLE,
  );
  assert.equal(
    await code(
      fetchSellerProfile({
        baseUrl: BASE,
        nodeId: 'AB'.repeat(32),
        fetch: async () => assert.fail('fetched'),
      }),
    ),
    DISCOVERY_ERROR_CODES.INVALID_INPUT,
  );
});

void test('a held name reads as PROFILE_HELD, and another 403 as an HTTP status', async () => {
  assert.equal(
    await code(
      fetchSellerProfile({
        baseUrl: BASE,
        nodeId: NODE,
        fetch: reply(403, { error: 'PROFILE_HELD' }),
      }),
    ),
    DISCOVERY_ERROR_CODES.PROFILE_HELD,
  );
  assert.equal(
    await code(
      fetchSellerProfile({
        baseUrl: BASE,
        nodeId: NODE,
        fetch: reply(403, { error: 'NOPE' }),
      }),
    ),
    DISCOVERY_ERROR_CODES.HTTP_STATUS,
  );
});
