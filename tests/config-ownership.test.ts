// Pins the values moved out of the former P2P config object so a split by owner cannot change a wire,
// limit, port or file name. Expected values are independent literals on purpose.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CHANNEL_SIGNATURES,
  MINIMUM_REQUESTS,
} from '@gyblos/buyer/constants';
import * as config from '@gyblos/config';
import {
  FILE_MODES,
  PORTS,
  ROLE_FILES,
  ROLE_KEY_FILES,
  TRANSPORT_LIMITS,
  TRANSPORT_TIMEOUTS,
} from '@gyblos/config';
import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import { NODE_KEY_BYTES } from '@gyblos/node/constants';
import { LOCK_METADATA_BYTES } from '@gyblos/payments-x402/constants';
import {
  HTTP_OVER_IROH,
  IROH_DEADLINES,
} from '@gyblos/transport-iroh/constants';

void test('HTTP-over-Iroh wire limits and internal deadlines keep their values', () => {
  assert.deepEqual(HTTP_OVER_IROH, {
    bodyBytes: 65536,
    headerBytes: 24576,
    responseBytes: 262144,
    maxHeaders: 32,
    headerTerminatorBytes: 4,
    maxHttpStatus: 599,
    streamCloseCode: 1n,
  });
  assert.deepEqual(IROH_DEADLINES, {
    ingressMs: 5000,
    egressMs: 5000,
    connectionIdleMs: 30000,
    connectionLifetimeMs: 900000,
    routePollMs: 100,
  });
});

void test('operator-tunable transport limits, timeouts and ports keep their values', () => {
  assert.deepEqual(TRANSPORT_LIMITS, {
    connectionAttemptsPerWindow: 256,
    connectionAttemptsPerSource: 32,
    connectionAttemptsPerPeer: 30,
    maxConcurrent: 2,
    maxPeerConcurrent: 1,
    maxConnections: 8,
    maxPendingConnections: 8,
    maxPendingPerSource: 2,
    maxPeerConnections: 1,
    maxEgressConcurrent: 8,
    maxPeers: 128,
    requestsPerWindow: 30,
    globalRequestsPerWindow: 256,
    rateWindowMs: 60000,
  });
  assert.deepEqual(TRANSPORT_TIMEOUTS, { connectMs: 30000, requestMs: 180000 });
  assert.equal(PORTS.buyerProxy, 4031);
  assert.equal(PORTS.seller, 4032);
});

void test('offer, payment-evidence, lock and key values keep their owners and values', () => {
  assert.equal(OFFER_LIFETIME_MS, 240000);
  assert.equal(MINIMUM_REQUESTS, 3);
  assert.equal(MAX_CHANNEL_SIGNATURES, 10);
  assert.equal(LOCK_METADATA_BYTES, 4096);
  assert.equal(NODE_KEY_BYTES, 32);
  assert.equal(FILE_MODES.permissionMask, 0o777);
  assert.equal('P2P' in config, false);
});

void test('role file and key names inside a role directory are unchanged', () => {
  assert.deepEqual(ROLE_FILES, {
    roleConfig: 'role.json',
    nodeKey: 'node.key',
    trust: 'trust.json',
    status: 'status.json',
    telemetry: 'telemetry',
    receipts: 'receipts',
    payments: 'payments',
    metrics: 'transport.jsonl',
    measurements: 'measurements.jsonl',
    measurementSalt: 'measurement-salt',
    buyerLock: 'buyer.lock',
    recoveryLock: 'recovery.lock',
    staleLockJournal: 'stale-locks.jsonl',
    journal: 'authorization.json',
    reconciliations: 'reconciliations.json',
    calls: 'calls.json',
    offer: 'offer.json',
    identityState: 'identity-state-8004.json',
    identityStateLock: 'identity-state-8004.lock',
    sellerRegistration: 'registration-8004-v1.json',
    sellerRegistrationLock: 'registration-8004-v1.lock',
    publicSequence: 'public-sequence-v2.json',
    publicSequenceLock: 'public-sequence-v2.lock',
    facilitatorDiagnostics: 'facilitator-diagnostics',
  });
  assert.deepEqual(ROLE_KEY_FILES, {
    buyer: 'buyer.json',
    owner: 'owner.json',
    authorizer: 'authorizer.json',
    facilitator: 'facilitator.json',
  });
});
