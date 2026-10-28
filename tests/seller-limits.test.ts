// gyblos.toml [limits] tunes the seller's capacity within hard ceilings; omitted keys keep today's values.
// Pure: parsed synthetic files, the settings resolver and the in-memory limiters; no network or engine.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';
import { createConnectionAdmission } from '@gyblos/transport-iroh/admission';
import { CONNECTION_FAMILIES } from '@gyblos/transport-iroh/constants';
import { createPeerLimiter } from '@gyblos/transport-iroh/limiter';

import { BASE, FREE_SELLER_OFFER } from './support/node-config-fixtures';

function settings(limits: string) {
  const parsed = parseNodeConfig(
    `${BASE}${FREE_SELLER_OFFER}[limits]\n${limits}\n`,
  );
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  return sellerSettings(parsed.config, {}).limits;
}

function issues(limits: string) {
  const parsed = parseNodeConfig(
    `${BASE}${FREE_SELLER_OFFER}[limits]\n${limits}\n`,
  );
  assert.equal(parsed.ok, false, limits);
  return !parsed.ok && parsed.issues.map(({ code, path }) => ({ code, path }));
}

// Distinct buyers, one per pool slot, that get a request lease when the server registers them; the pool
// size itself is enforced by connection admission.
function connectedBuyers(limits: ReturnType<typeof settings>) {
  const limiter = createPeerLimiter(() => 0, limits.transport);
  let admitted = 0;
  for (let index = 0; index < limits.transport.maxConnections; index++)
    if (limiter.register(`buyer-${index}`, CONNECTION_FAMILIES.DATA))
      admitted++;
  return admitted;
}

void test('without [limits] the seller keeps the built-in limits', () => {
  const parsed = parseNodeConfig(BASE + FREE_SELLER_OFFER);
  assert.ok(parsed.ok);
  assert.deepEqual(sellerSettings(parsed.config, {}).limits, {
    transport: TRANSPORT_LIMITS,
    maxFreeBuyers: FREE_EXECUTION_ADMISSION.maxBuyers,
  });
});

void test('[limits] values reach the transport limits the seller serves with', () => {
  const limits = settings(
    [
      'max_connections = 16',
      'requests_per_minute = 60',
      'global_requests_per_minute = 1024',
      'max_free_buyers_per_day = 10',
    ].join('\n'),
  );
  assert.deepEqual(limits, {
    transport: {
      ...TRANSPORT_LIMITS,
      maxConnections: 16,
      requestsPerWindow: 60,
      globalRequestsPerWindow: 1024,
      // Raised with the request rate: free execution opens one connection per request.
      connectionAttemptsPerPeer: 60,
      connectionAttemptsPerSource: 60,
      connectionAttemptsPerWindow: 1024,
    },
    maxFreeBuyers: 10,
  });

  // One buyer gets 60 requests per window instead of 30.
  const limiter = createPeerLimiter(() => 0, limits.transport);
  let admitted = 0;
  for (let index = 0; index < 100; index++) {
    const release = limiter.enter('buyer');
    if (!release) break;
    release();
    admitted++;
  }
  assert.equal(admitted, 60);

  // ...and as many connection attempts, so a free buyer is not capped at 30 connections.
  const admission = createConnectionAdmission(() => 0, limits.transport);
  let connections = 0;
  for (let index = 0; index < 100; index++) {
    const release = admission.established('buyer', CONNECTION_FAMILIES.DATA);
    if (!release) break;
    release();
    connections++;
  }
  assert.equal(connections, 60);

  // Every one of the 16 connections can be held by a different buyer.
  assert.equal(connectedBuyers(limits), 16);
});

void test('every accepted [limits] file admits a full connection pool', () => {
  for (const toml of [
    '',
    'max_connections = 64\nrequests_per_minute = 16\nglobal_requests_per_minute = 1024',
    'max_connections = 8\nrequests_per_minute = 120\nglobal_requests_per_minute = 1024',
    'max_connections = 1\nrequests_per_minute = 120\nglobal_requests_per_minute = 120',
  ]) {
    const limits = settings(toml);
    assert.equal(
      connectedBuyers(limits),
      limits.transport.maxConnections,
      toml,
    );
  }
});

void test('[limits] refuses values outside the ceilings and budgets that cannot cover the pool', () => {
  for (const [toml, path] of [
    ['max_connections = 0', 'limits.max_connections'],
    ['max_connections = 65', 'limits.max_connections'],
    ['requests_per_minute = 121', 'limits.requests_per_minute'],
    ['global_requests_per_minute = 1025', 'limits.global_requests_per_minute'],
    ['max_free_buyers_per_day = 65537', 'limits.max_free_buyers_per_day'],
    // 8 connections x 60 per minute does not fit the built-in 256 total; the set key is named.
    ['requests_per_minute = 60', 'limits.requests_per_minute'],
    ['max_connections = 16', 'limits.max_connections'],
    // A total set too low is named even though the per-buyer value is the default.
    ['global_requests_per_minute = 10', 'limits.global_requests_per_minute'],
    // The total is named first when several keys are set.
    [
      'max_connections = 64\nrequests_per_minute = 120\nglobal_requests_per_minute = 1024',
      'limits.global_requests_per_minute',
    ],
    // An out-of-range value is the only issue; the budget is not checked against a fallback.
    [
      'requests_per_minute = 100\nglobal_requests_per_minute = 5000',
      'limits.global_requests_per_minute',
    ],
  ] as const)
    assert.deepEqual(issues(toml), [{ code: 'INVALID_LIMIT', path }], toml);

  assert.deepEqual(issues('max_peer_connections = 2'), [
    { code: 'UNKNOWN_KEY', path: 'limits.max_peer_connections' },
  ]);
  assert.deepEqual(issues('max_concurrent = 4'), [
    { code: 'UNKNOWN_KEY', path: 'limits.max_concurrent' },
  ]);
  assert.deepEqual(issues('max_connections = 8.0'), [
    { code: 'WRONG_TYPE', path: 'limits.max_connections' },
  ]);
  const notTable = parseNodeConfig(
    BASE.replace('[node]', 'limits = 8\n[node]'),
  );
  assert.deepEqual(
    !notTable.ok && notTable.issues.map(({ code, path }) => ({ code, path })),
    [{ code: 'WRONG_TYPE', path: 'limits' }],
  );
});
