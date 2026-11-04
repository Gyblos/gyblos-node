// Relay-only keeps a peer's IP hidden. A relay-only endpoint binds only loopback, so the one direct
// path it can ever select is to another process on the same machine, which reveals nothing; that path
// is allowed so a buyer and a seller can be tested on one host. Fake path lists only; nothing binds.
import assert from 'node:assert/strict';
import test from 'node:test';

import { relayOnlyAllows } from '@gyblos/transport-iroh/paths';

const path = (remoteAddr: string | undefined, relay = false) => ({
  isSelected: true,
  isIp: !relay,
  isRelay: relay,
  ...(remoteAddr === undefined ? {} : { remoteAddr }),
});
const connection = (...paths: ReturnType<typeof path>[]) => ({
  paths: () => paths as never,
});

void test('relay-only allows the relay and same-machine loopback paths only', () => {
  for (const allowed of [
    path('https://na1.relay.gyblos.com/', true),
    path('127.0.0.1:51234'),
    path('127.8.9.10:1'),
    path('[::1]:51234'),
    path('::1'),
    path('[::ffff:127.0.0.1]:51234'),
  ])
    assert.equal(
      relayOnlyAllows(connection(allowed)),
      true,
      String(allowed.remoteAddr),
    );
  for (const refused of [
    path('192.168.1.20:51234'),
    path('203.0.113.9:443'),
    path('[2001:db8::1]:51234'),
    path('[::ffff:203.0.113.9]:51234'),
    path('128.0.0.1:1'),
    path('localhost:51234'),
    path(undefined),
  ])
    assert.equal(
      relayOnlyAllows(connection(refused)),
      false,
      String(refused.remoteAddr),
    );
  assert.equal(relayOnlyAllows(connection()), false);
  assert.equal(
    relayOnlyAllows(connection(path('127.0.0.1:1'), path('127.0.0.1:2'))),
    false,
  );
});
