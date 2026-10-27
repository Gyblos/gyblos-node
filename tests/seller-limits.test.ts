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

import { BASE } from './support/node-config-fixtures.js';

function settings(limits: string) {
  const parsed = parseNodeConfig(`${BASE}[limits]\n${limits}\n`);
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  return sellerSettings(parsed.config, {}).limits;
}

void test('without [limits] the seller keeps the built-in limits', () => {
  const parsed = parseNodeConfig(BASE);
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
      'max_peer_connections = 2',
      'requests_per_minute = 60',
      'global_requests_per_minute = 512',
      'max_free_buyers_per_day = 10',
    ].join('\n'),
  );
  assert.deepEqual(limits, {
    transport: {
      ...TRANSPORT_LIMITS,
      maxConnections: 16,
      maxPeerConnections: 2,
      requestsPerWindow: 60,
      globalRequestsPerWindow: 512,
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

  // Two connections of one family per buyer instead of one.
  const admission = createConnectionAdmission(() => 0, limits.transport);
  const held = [1, 2, 3].map(() =>
    admission.established('buyer', CONNECTION_FAMILIES.DATA),
  );
  assert.equal(held.filter(Boolean).length, 2);
});

void test('[limits] refuses values outside the ceilings and incoherent pairs', () => {
  for (const [toml, path] of [
    ['max_connections = 0', 'limits.max_connections'],
    ['max_connections = 65', 'limits.max_connections'],
    ['max_peer_connections = 5', 'limits.max_peer_connections'],
    ['requests_per_minute = 601', 'limits.requests_per_minute'],
    ['global_requests_per_minute = 4097', 'limits.global_requests_per_minute'],
    ['max_free_buyers_per_day = 65537', 'limits.max_free_buyers_per_day'],
    // Three per buyer cannot fit in two in total.
    [
      'max_connections = 2\nmax_peer_connections = 3',
      'limits.max_peer_connections',
    ],
    // Built-in global budget is 256 per minute.
    ['requests_per_minute = 300', 'limits.requests_per_minute'],
  ] as const) {
    const parsed = parseNodeConfig(`${BASE}[limits]\n${toml}\n`);
    assert.equal(parsed.ok, false, toml);
    assert.deepEqual(
      !parsed.ok && parsed.issues.map(({ code, path }) => ({ code, path })),
      [{ code: 'INVALID_LIMIT', path }],
      toml,
    );
  }
  const typo = parseNodeConfig(`${BASE}[limits]\nmax_concurrent = 4\n`);
  assert.equal(typo.ok, false);
  assert.equal(!typo.ok && typo.issues[0]!.code, 'UNKNOWN_KEY');
  const float = parseNodeConfig(`${BASE}[limits]\nmax_connections = 8.0\n`);
  assert.equal(!float.ok && float.issues[0]!.code, 'WRONG_TYPE');
});
