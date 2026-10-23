// Pins the values moved out of the P2P config object so a split by owner cannot change a wire,
// limit or port. Expected values are independent literals on purpose.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PORTS, TRANSPORT_LIMITS, TRANSPORT_TIMEOUTS } from '@gyblos/config';
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
