// Protects the registration contract between @gyblos/discovery-http's registerSeller and the discovery
// index app, over an in-process fetch at DISCOVERY_INDEX_URL: success and retry, each refusal code, the
// client's own input checks, and that the client's invite and NodeId shapes match what the index accepts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  DISCOVERY_ERROR_CODES,
  registerSeller,
  REGISTRATION_FORMAT,
  REGISTRATION_RESULTS,
} from '@gyblos/discovery-http';
import {
  REGISTRATION,
  REGISTRATION_STATUS,
} from '@gyblos/discovery-index/constants';

import { rejectsWith } from './support/discovery-fixture';
import { enrollmentHarness, inviteCode } from './support/registration-fixture';

const refuses = (
  promise: Promise<unknown>,
  code: Parameters<typeof rejectsWith>[0],
) => assert.rejects(promise, rejectsWith(code));

const NODE_ID = 'ab'.repeat(32);

function clientFetch(app: {
  fetch: (request: Request) => Response | Promise<Response>;
}) {
  const urls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    return app.fetch(new Request(url, init));
  };
  return { urls, fetch };
}

void test('registerSeller: the client accepts exactly the invite and NodeId shapes the index accepts', () => {
  assert.equal(REGISTRATION_FORMAT.invite.source, REGISTRATION.invite.source);
  assert.equal(REGISTRATION_FORMAT.nodeId.source, REGISTRATION.nodeId.source);
});

void test('registerSeller: registers once, then reports the same invite and NodeId as already active', async () => {
  const harness = (await enrollmentHarness('memory'))!;
  const invite = await harness.invite();
  const client = clientFetch(harness.app);
  const input = {
    baseUrl: DISCOVERY_INDEX_URL,
    invite,
    nodeId: NODE_ID,
    fetch: client.fetch,
  };
  assert.equal(await registerSeller(input), REGISTRATION_RESULTS.REGISTERED);
  assert.equal(
    await registerSeller(input),
    REGISTRATION_RESULTS.ALREADY_ACTIVE,
  );
  assert.deepEqual(client.urls, [
    `${DISCOVERY_INDEX_URL}/registrations`,
    `${DISCOVERY_INDEX_URL}/registrations`,
  ]);
});

void test('registerSeller: each index refusal surfaces as its own code', async () => {
  const harness = (await enrollmentHarness('memory', {
    chain: () => 'missing',
  }))!;
  const { fetch } = clientFetch(harness.app);
  const base = { baseUrl: DISCOVERY_INDEX_URL, nodeId: NODE_ID, fetch };
  await refuses(
    registerSeller({ ...base, invite: inviteCode() }),
    DISCOVERY_ERROR_CODES.INVITE_INVALID,
  );
  await refuses(
    registerSeller({ ...base, invite: await harness.invite() }),
    DISCOVERY_ERROR_CODES.IDENTITY_NOT_REGISTERED,
  );
  const admitted = (await enrollmentHarness('memory'))!;
  const invite = await admitted.invite();
  const admittedFetch = clientFetch(admitted.app).fetch;
  await registerSeller({ ...base, invite, fetch: admittedFetch });
  await admitted.setStatus(NODE_ID, REGISTRATION_STATUS.REVOKED);
  await refuses(
    registerSeller({ ...base, invite, fetch: admittedFetch }),
    DISCOVERY_ERROR_CODES.NODE_REVOKED,
  );
});

void test('registerSeller: malformed input and a plain-http index are refused before any request', async () => {
  const sent: string[] = [];
  const fetch = async (url: string) => {
    sent.push(url);
    return new Response(null, { status: 500 });
  };
  const base = { baseUrl: DISCOVERY_INDEX_URL, fetch };
  for (const input of [
    { ...base, invite: 'gyb_short', nodeId: NODE_ID },
    { ...base, invite: inviteCode(), nodeId: 'AB'.repeat(32) },
    { ...base, invite: inviteCode().toUpperCase(), nodeId: NODE_ID },
  ])
    await refuses(registerSeller(input), DISCOVERY_ERROR_CODES.INVALID_INPUT);
  await refuses(
    registerSeller({
      ...base,
      baseUrl: 'http://discovery.gyblos.com/v1',
      invite: inviteCode(),
      nodeId: NODE_ID,
    }),
    DISCOVERY_ERROR_CODES.INSECURE_URL,
  );
  assert.deepEqual(sent, []);
});

void test('registerSeller: an unreadable refusal is still a refusal; an unexpected success body is malformed', async () => {
  const answer = (status: number, body: string) => async () =>
    new Response(body, { status });
  const base = {
    baseUrl: DISCOVERY_INDEX_URL,
    invite: inviteCode(),
    nodeId: NODE_ID,
  };
  await refuses(
    registerSeller({ ...base, fetch: answer(403, 'not json') }),
    DISCOVERY_ERROR_CODES.REGISTRATION_REJECTED,
  );
  await refuses(
    registerSeller({
      ...base,
      fetch: answer(201, JSON.stringify({ ok: true, status: 'revoked' })),
    }),
    DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
  );
  await refuses(
    registerSeller({ ...base, fetch: answer(302, '') }),
    DISCOVERY_ERROR_CODES.HTTP_STATUS,
  );
});
