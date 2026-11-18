// Pins the uptime client: one GET with the public NodeId, 404 as "never seen", and strict checks on what an
// untrusted index returns. Synthetic responses only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_ERROR_CODES, fetchUptime } from '@gyblos/discovery-http';

import {
  DISCOVERY_BASE,
  fakeFetch,
  jsonResponse,
} from './support/discovery-fixture';

const NODE = 'ab'.repeat(32);
const report = (overrides: Record<string, unknown> = {}) => ({
  nodeId: NODE,
  firstSeenAt: 1_000,
  lastSeenAt: 2_000,
  slotMs: 300_000,
  windows: [{ days: 1, seen: 287, slots: 288, ratio: 0.9965 }],
  generatedAt: 3_000,
  ...overrides,
});
const ask = (respond: Parameters<typeof fakeFetch>[0]) => {
  const index = fakeFetch(respond);
  return {
    index,
    run: () =>
      fetchUptime({
        baseUrl: DISCOVERY_BASE,
        nodeId: NODE,
        fetch: index.fetch,
      }),
  };
};

void test('uptime: one GET for the NodeId, parsed when well formed, null when never seen', async () => {
  const ok = ask(() => jsonResponse(200, report()));
  assert.deepEqual(await ok.run(), {
    firstSeenAt: 1_000,
    lastSeenAt: 2_000,
    windows: [{ days: 1, seen: 287, slots: 288, ratio: 0.9965 }],
    generatedAt: 3_000,
  });
  assert.deepEqual(
    ok.index.calls.map((call) => call.url),
    [`${DISCOVERY_BASE}/uptime?node=${NODE}`],
  );
  const unseen = ask(() => jsonResponse(404, { error: 'NOT_FOUND' }));
  assert.equal(await unseen.run(), null);
  const quiet = ask(() => jsonResponse(200, report({ lastSeenAt: null })));
  assert.equal((await quiet.run())?.lastSeenAt, null);
});

void test('uptime: another NodeId, impossible windows or extra fields are malformed', async () => {
  for (const body of [
    report({ nodeId: 'cd'.repeat(32) }),
    report({ windows: [{ days: 1, seen: 300, slots: 288, ratio: 1 }] }),
    report({ windows: [{ days: 1, seen: 1, slots: 288, ratio: 1.5 }] }),
    report({ windows: [{ days: 1, seen: 1, slots: 288, ratio: 0.1, x: 1 }] }),
    report({ extra: true }),
    report({ firstSeenAt: -1 }),
    { ...report(), windows: 'all' },
  ])
    await assert.rejects(ask(() => jsonResponse(200, body)).run(), {
      code: DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    });
});

void test('uptime: refuses a malformed NodeId before any request', async () => {
  const index = fakeFetch(() => jsonResponse(200, report()));
  await assert.rejects(
    fetchUptime({
      baseUrl: DISCOVERY_BASE,
      nodeId: 'not-a-node',
      fetch: index.fetch,
    }),
    { code: DISCOVERY_ERROR_CODES.INVALID_INPUT },
  );
  assert.equal(index.calls.length, 0);
});
