// Registers transport quota limiter cases: request debt survives reconnects and eviction, leases
// release once, and budgets reset only at rollover.
import assert from 'node:assert/strict';
import test from 'node:test';

import { P2P } from '@gyblos/config';
import { createPeerLimiter } from '@gyblos/transport-iroh/limiter';

type Limiter = ReturnType<typeof createPeerLimiter>;

function request(limiter: Limiter, peer: string) {
  const release = limiter.enter(peer);
  if (!release) return false;
  release();
  return true;
}
function single(limiter: Limiter, peer: string) {
  const lease = limiter.register(peer);
  if (!lease) return false;
  const result = request(limiter, peer);
  lease();
  return result;
}
function consume(limiter: Limiter) {
  let total = 0;
  for (let index = 0; index <= P2P.globalRequestsPerWindow; index++) {
    const peer = 'spender-' + index;
    const lease = limiter.register(peer);
    if (!lease) break;
    while (request(limiter, peer)) total++;
    lease();
  }
  return total;
}

export function registerLimiterCases() {
  void test('a connected partial grant cannot refill until its lease ends, even after capacity is released', () => {
    const limiter = createPeerLimiter(() => 0);
    const spent = limiter.register('spent');
    assert.ok(spent);
    for (let index = 0; index < P2P.requestsPerWindow; index++)
      assert.ok(request(limiter, 'spent'));
    spent();
    const held: (() => void)[] = [];
    for (let index = 0; index < 7; index++) {
      const lease = limiter.register('held-' + index);
      assert.ok(lease);
      held.push(lease);
    }
    const partial = limiter.register('partial');
    assert.ok(partial);
    const granted = P2P.globalRequestsPerWindow - P2P.requestsPerWindow * 8;
    for (let index = 0; index < granted; index++)
      assert.ok(request(limiter, 'partial'));
    held[0]!();
    assert.equal(
      limiter.enter('partial'),
      undefined,
      'An existing lease cannot refill its exhausted partial grant.',
    );
    partial();
    const returning = limiter.register('partial');
    assert.ok(returning);
    for (let index = granted; index < P2P.requestsPerWindow; index++)
      assert.ok(request(limiter, 'partial'));
    assert.equal(limiter.enter('partial'), undefined);
    returning();
    for (const release of held) release();
  });
  void test('nine free requests followed by disconnects preserve newcomer admission', () => {
    const limiter = createPeerLimiter(() => 0);
    for (let index = 0; index < 9; index++)
      assert.ok(single(limiter, 'free-' + index));
    const newcomer = limiter.register('newcomer');
    assert.ok(newcomer);
    for (let index = 0; index < P2P.requestsPerWindow; index++)
      assert.ok(request(limiter, 'newcomer'));
    assert.equal(request(limiter, 'newcomer'), false);
    newcomer();
    assert.ok(single(limiter, 'free-0'));
  });
  void test('255 actual requests leave one admission and the 256th exhausts the budget', () => {
    const limiter = createPeerLimiter(() => 0);
    for (let index = 0; index < P2P.globalRequestsPerWindow - 1; index++)
      assert.ok(single(limiter, 'peer-' + index));
    assert.ok(single(limiter, 'last'));
    assert.equal(limiter.register('over-budget'), undefined);
    assert.equal(limiter.enter('over-budget'), undefined);
  });
  void test('seven protected reservations plus 46 real admissions exhaust new capacity', () => {
    const limiter = createPeerLimiter(() => 0);
    const leases: (() => void)[] = [];
    for (let index = 0; index < 7; index++) {
      const lease = limiter.register('held-' + index);
      assert.ok(lease);
      leases.push(lease);
    }
    assert.equal(consume(limiter), 46);
    assert.equal(limiter.register('newcomer'), undefined);
    leases[0]!();
    assert.ok(single(limiter, 'newcomer'));
    for (const lease of leases) lease();
  });
  for (const spent of [7, P2P.requestsPerWindow])
    void test(
      'LRU eviction and reconnect preserve identity debt=' + spent,
      () => {
        const limiter = createPeerLimiter(() => 0);
        const lease = limiter.register('known');
        assert.ok(lease);
        for (let index = 0; index < spent; index++)
          assert.ok(request(limiter, 'known'));
        lease();
        for (let index = 0; index < P2P.maxPeers + 5; index++)
          assert.ok(single(limiter, 'churn-' + index));
        const next = limiter.register('known');
        if (spent === P2P.requestsPerWindow) {
          assert.equal(next, undefined);
          assert.equal(limiter.enter('known'), undefined);
        } else {
          assert.ok(next);
          let left = 0;
          while (request(limiter, 'known')) left++;
          assert.equal(left, P2P.requestsPerWindow - spent);
          next();
        }
      },
    );
  void test('repeated same-identity reconnects never reset request debt', () => {
    const limiter = createPeerLimiter(() => 0);
    for (let index = 0; index < P2P.requestsPerWindow; index++)
      assert.ok(single(limiter, 'known'));
    assert.equal(limiter.register('known'), undefined);
    assert.ok(single(limiter, 'different'));
  });
  void test('connected and active ownership remain protected when inactive grace is reclaimed', () => {
    const limiter = createPeerLimiter(() => 0);
    const lease = limiter.register('active');
    assert.ok(lease);
    const active = limiter.enter('active');
    assert.ok(active);
    lease();
    assert.equal(
      consume(limiter),
      P2P.globalRequestsPerWindow - P2P.requestsPerWindow,
    );
    const returning = limiter.register('active');
    assert.ok(returning);
    assert.equal(limiter.enter('active'), undefined);
    active();
    let left = 0;
    while (request(limiter, 'active')) left++;
    assert.equal(left, P2P.requestsPerWindow - 1);
    returning();
  });
  void test('late duplicate lease release cannot discard the reconnected reservation', () => {
    const limiter = createPeerLimiter(() => 0);
    const first = limiter.register('known');
    assert.ok(first);
    assert.ok(request(limiter, 'known'));
    first();
    const second = limiter.register('known');
    assert.ok(second);
    first();
    first();
    assert.equal(
      consume(limiter),
      P2P.globalRequestsPerWindow - P2P.requestsPerWindow,
    );
    let left = 0;
    while (request(limiter, 'known')) left++;
    assert.equal(left, P2P.requestsPerWindow - 1);
    second();
  });
  void test('zero-work connection churn returns unused quota without erasing consumed debt', () => {
    const limiter = createPeerLimiter(() => 0);
    for (let index = 0; index < P2P.maxPeers * 4; index++) {
      const lease = limiter.register('empty-' + index);
      assert.ok(lease);
      lease();
      lease();
    }
    assert.equal(consume(limiter), P2P.globalRequestsPerWindow);
  });
  void test('rollover resets request debt while preserving an old in-flight operation', () => {
    let time = 0;
    const limiter = createPeerLimiter(() => time);
    const lease = limiter.register('active');
    assert.ok(lease);
    const active = limiter.enter('active');
    assert.ok(active);
    lease();
    time = P2P.rateWindowMs;
    const next = limiter.register('active');
    assert.ok(next);
    assert.equal(limiter.enter('active'), undefined);
    active();
    assert.ok(request(limiter, 'active'));
    next();
  });
  void test('actual budget exhaustion denies a known disconnected peer until rollover', () => {
    let time = 0;
    const limiter = createPeerLimiter(() => time);
    assert.ok(single(limiter, 'known'));
    assert.equal(consume(limiter), P2P.globalRequestsPerWindow - 1);
    assert.equal(limiter.register('known'), undefined);
    time = P2P.rateWindowMs;
    assert.ok(single(limiter, 'known'));
  });
  void test('origin concurrency and duplicate releases remain bounded independently of quota', () => {
    const limiter = createPeerLimiter(() => 0);
    const one = limiter.register('one');
    const two = limiter.register('two');
    const three = limiter.register('three');
    assert.ok(one);
    assert.ok(two);
    assert.ok(three);
    const first = limiter.enter('one');
    const second = limiter.enter('two');
    assert.ok(first);
    assert.ok(second);
    assert.equal(limiter.enter('one'), undefined);
    assert.equal(limiter.enter('three'), undefined);
    first();
    first();
    assert.ok(request(limiter, 'three'));
    second();
    one();
    two();
    three();
  });
}
