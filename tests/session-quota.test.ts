// Mixed-session connection and concurrency leases do not reserve or reset inference quota.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { CONNECTION_FAMILIES } from '@gyblos/transport-iroh/constants';
import { createPeerLimiter } from '@gyblos/transport-iroh/limiter';

void test('session reconnect permits administration after quota without resetting execution debt', () => {
  const limits = {
    ...TRANSPORT_LIMITS,
    requestsPerWindow: 1,
    globalRequestsPerWindow: 1,
  };
  const limiter = createPeerLimiter(() => 0, limits);
  const connection = limiter.registerQuery('buyer', CONNECTION_FAMILIES.DATA);
  assert.ok(connection);
  assert.equal(
    limiter.consume('buyer'),
    false,
    'No concurrency lease is held.',
  );
  const execution = limiter.enterQuery('buyer');
  assert.ok(execution);
  assert.equal(limiter.consume('buyer'), true);
  assert.equal(limiter.consume('buyer'), false);
  assert.equal(limiter.enterQuery('buyer'), undefined);
  execution();
  connection();
  const reconnect = limiter.registerQuery('buyer', CONNECTION_FAMILIES.DATA);
  assert.ok(reconnect);
  const management = limiter.enterQuery('buyer');
  assert.ok(management);
  assert.equal(
    limiter.consume('buyer'),
    false,
    'Reconnect cannot erase quota.',
  );
  management();
  management();
  reconnect();
  assert.equal(
    limiter.enter('new-buyer'),
    undefined,
    'Global inference budget is still spent.',
  );
});

void test('session-only connections reserve no execution allowance, including on rollover', () => {
  let now = 0;
  const limits = {
    ...TRANSPORT_LIMITS,
    requestsPerWindow: 1,
    globalRequestsPerWindow: 1,
  };
  const limiter = createPeerLimiter(() => now, limits);
  const session = limiter.registerQuery('idle', CONNECTION_FAMILIES.DATA);
  assert.ok(session);
  for (let index = 0; index < 2; index++) {
    const execution = limiter.enter('other');
    assert.ok(
      execution,
      'An idle management connection must not reserve the global allowance.',
    );
    execution();
    const query = limiter.enterQuery('idle');
    assert.ok(query);
    assert.equal(limiter.consume('idle'), false);
    query();
    now += limits.rateWindowMs;
  }
  session();
});

void test('mixed sessions share data-family connections, peer tables and global concurrency', () => {
  const limits = { ...TRANSPORT_LIMITS, maxPeers: 2 };
  const limiter = createPeerLimiter(() => 0, limits);
  const one = limiter.registerQuery('one', CONNECTION_FAMILIES.DATA);
  const two = limiter.registerQuery('two', CONNECTION_FAMILIES.DATA);
  assert.ok(one && two);
  assert.equal(
    limiter.registerQuery('one', CONNECTION_FAMILIES.DATA),
    undefined,
  );
  assert.equal(limiter.register('one', CONNECTION_FAMILIES.DATA), undefined);
  assert.equal(
    limiter.registerQuery('three', CONNECTION_FAMILIES.DATA),
    undefined,
  );
  const first = limiter.enterQuery('one');
  const second = limiter.enter('two');
  assert.ok(first && second);
  assert.equal(limiter.enterQuery('three'), undefined);
  assert.equal(limiter.enter('one'), undefined);
  assert.equal(
    limiter.consume('one'),
    true,
    'Promotion must not require a third slot.',
  );
  first();
  first();
  second();
  one();
  two();
  assert.ok(limiter.registerQuery('three', CONNECTION_FAMILIES.DATA));
});

void test('session eviction retains consumed identity debt and cancellation releases capacity once', () => {
  const limits = { ...TRANSPORT_LIMITS, maxPeers: 1, requestsPerWindow: 1 };
  const limiter = createPeerLimiter(() => 0, limits);
  const connection = limiter.registerQuery('buyer', CONNECTION_FAMILIES.DATA);
  const execution = limiter.enterQuery('buyer');
  assert.ok(connection && execution);
  assert.equal(limiter.consume('buyer'), true);
  connection();
  assert.equal(
    limiter.registerQuery('other', CONNECTION_FAMILIES.DATA),
    undefined,
  );
  execution();
  execution();
  const other = limiter.registerQuery('other', CONNECTION_FAMILIES.DATA);
  assert.ok(other);
  other();
  const reconnect = limiter.registerQuery('buyer', CONNECTION_FAMILIES.DATA);
  const query = limiter.enterQuery('buyer');
  assert.ok(reconnect && query);
  assert.equal(limiter.consume('buyer'), false);
  query();
  reconnect();
});
