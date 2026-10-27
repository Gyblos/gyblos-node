// A buyer closes its control (quote) connection and immediately dials the data (execution) connection;
// over a relay the seller may still hold the first. Per-peer caps therefore apply per connection family,
// while the global connection pool and the per-peer request quota stay shared.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import {
  CONTROL_ALPN,
  FREE_EXECUTION,
  FREE_STREAM,
  GYBLOS_ALPN,
} from '@gyblos/protocol/constants';
import {
  connectionFamily,
  createConnectionAdmission,
} from '@gyblos/transport-iroh/admission';
import { CONNECTION_FAMILIES } from '@gyblos/transport-iroh/constants';
import { createPeerLimiter } from '@gyblos/transport-iroh/limiter';

const { CONTROL, DATA } = CONNECTION_FAMILIES;

void test('ALPNs map to the control family or the data family', () => {
  assert.equal(connectionFamily(CONTROL_ALPN), CONTROL);
  for (const alpn of [GYBLOS_ALPN, FREE_EXECUTION.alpn, FREE_STREAM.alpn])
    assert.equal(connectionFamily(alpn), DATA, alpn);
  assert.equal(connectionFamily('unknown/1'), DATA);
});

void test('admission: a lingering control connection does not block the same peer data connection', () => {
  const admission = createConnectionAdmission();
  const control = admission.established('buyer', CONTROL);
  assert.ok(control);
  const data = admission.established('buyer', DATA);
  assert.ok(data, 'data connection refused while control is still held');
  // Each family keeps the existing per-peer cap.
  assert.equal(admission.established('buyer', CONTROL), undefined);
  assert.equal(admission.established('buyer', DATA), undefined);
  control();
  const again = admission.established('buyer', CONTROL);
  assert.ok(again);
  again();
  data();
});

void test('admission: both families still count toward the global connection pool', () => {
  const admission = createConnectionAdmission();
  const leases: (() => void)[] = [];
  for (
    let index = 0;
    leases.length < TRANSPORT_LIMITS.maxConnections;
    index++
  ) {
    const lease = admission.established(
      `peer-${index}`,
      index % 2 ? CONTROL : DATA,
    );
    assert.ok(lease);
    leases.push(lease);
  }
  assert.equal(admission.established('late', CONTROL), undefined);
  assert.equal(admission.established('late', DATA), undefined);
  for (const release of leases) release();
});

void test('limiter: control and data leases coexist per peer and share one request quota', () => {
  let now = 0;
  const limiter = createPeerLimiter(() => now);
  const control = limiter.register('buyer', CONTROL);
  assert.ok(control);
  const data = limiter.register('buyer', DATA);
  assert.ok(data, 'data lease refused while the control lease is still held');
  assert.equal(limiter.register('buyer', CONTROL), undefined);
  assert.equal(limiter.register('buyer', DATA), undefined);
  // The per-peer request quota is shared, not doubled by the second family.
  let admitted = 0;
  for (let index = 0; index < TRANSPORT_LIMITS.requestsPerWindow * 2; index++) {
    const enter = limiter.enter('buyer');
    if (!enter) break;
    admitted++;
    enter();
  }
  assert.equal(admitted, TRANSPORT_LIMITS.requestsPerWindow);
  control();
  data();
  now += TRANSPORT_LIMITS.rateWindowMs;
});
