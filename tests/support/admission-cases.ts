import assert from 'node:assert/strict';
import test from 'node:test';

import { P2P } from '@gyblos/config';
import {
  connectionSource,
  createConnectionAdmission,
} from '@gyblos/transport-iroh/admission';

export function registerAdmissionCases() {
  test('established per-peer admission cap applies while the global pool has capacity', () => {
    const admission = createConnectionAdmission(),
      leases: (() => void)[] = [];
    assert.ok(P2P.maxPeerConnections < P2P.maxConnections);
    for (let index = 0; index < P2P.maxPeerConnections; index++) {
      const lease = admission.established('one-peer');
      assert.ok(lease);
      leases.push(lease);
    }
    assert.equal(admission.established('one-peer'), undefined);
    const other = admission.established('different-peer');
    assert.ok(other);
    leases[0]!();
    leases[0]!();
    const returning = admission.established('one-peer');
    assert.ok(returning);
    assert.equal(admission.established('one-peer'), undefined);
    returning();
    other();
    for (const release of leases) release();
  });
  test('source ports share one IP pending budget; malformed sources are refused', () => {
    assert.equal(
      connectionSource({ kind: 'ip', addr: '192.0.2.1:1000' }),
      connectionSource({ kind: 'ip', addr: '192.0.2.1:2000' }),
    );
    assert.equal(
      connectionSource({ kind: 'ip', addr: '[2001:db8::1]:1000' }),
      'ip:2001:db8::1',
    );
    for (const addr of [
      '',
      'not-an-ip:1000',
      'user@192.0.2.1:1000',
      '192.0.2.1',
      '192.0.2.1:1000/path',
    ])
      assert.equal(connectionSource({ kind: 'ip', addr }), undefined);
  });
  test('relay identity sources and full IPv6 address keys retain their documented boundary', () => {
    assert.equal(
      connectionSource({ kind: 'relay', endpointId: 'ABC' }),
      'relay:abc',
    );
    assert.notEqual(
      connectionSource({ kind: 'ip', addr: '[2001:db8::1]:1000' }),
      connectionSource({ kind: 'ip', addr: '[2001:db8::2]:1000' }),
    );
    assert.notEqual(
      connectionSource({ kind: 'ip', addr: '[::ffff:192.0.2.1]:1000' }),
      connectionSource({ kind: 'ip', addr: '192.0.2.1:1000' }),
    );
  });
  test('pending and established pools have independent global and per-source limits', () => {
    const admission = createConnectionAdmission(),
      pending: (() => void)[] = [],
      established: (() => void)[] = [];
    for (let index = 0; index < P2P.maxPendingConnections; index++) {
      const release = admission.pending(
        'source-' + Math.floor(index / P2P.maxPendingPerSource),
      );
      assert.ok(release);
      pending.push(release);
    }
    assert.equal(admission.pending('other-source'), undefined);
    for (let index = 0; index < P2P.maxConnections; index++) {
      const release = admission.established('peer-' + index);
      assert.ok(release);
      established.push(release);
    }
    assert.equal(admission.established('another-peer'), undefined);
    assert.equal(admission.established('peer-0'), undefined);
    pending[0]!();
    pending[0]!();
    const nextPending = admission.pending('source-0');
    assert.ok(nextPending);
    assert.equal(admission.established('another-peer'), undefined);
    established[0]!();
    established[0]!();
    const nextEstablished = admission.established('another-peer');
    assert.ok(nextEstablished);
    nextPending();
    nextEstablished();
    for (const release of [...pending, ...established]) release();
  });
  test('one source cannot bypass its pending limit using multiple connections', () => {
    const admission = createConnectionAdmission(),
      leases: (() => void)[] = [];
    for (let index = 0; index < P2P.maxPendingPerSource; index++) {
      const lease = admission.pending('one-source');
      assert.ok(lease);
      leases.push(lease);
    }
    assert.equal(admission.pending('one-source'), undefined);
    const different = admission.pending('another-source');
    assert.ok(different);
    different();
    for (const lease of leases) lease();
    assert.ok(admission.pending('one-source'));
  });
}
