// Exercises proposed control quotas using a monotonic fake clock; no sockets or timers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlAdmission } from '@gyblos/core/control-admission';
import { CONTROL_CAPACITY, CONTROL_CODES } from '@gyblos/protocol/constants';

const peer = (index: number) => index.toString(16).padStart(64, '0');
void test('control quotas aggregate connections and active queries across a peer with no queue', () => {
  const admission = new ControlAdmission(() => 0);
  const connections = Array.from(
    { length: CONTROL_CAPACITY.connectionsPerPeer },
    () => admission.openConnection(peer(1)),
  );
  assert.throws(() => admission.openConnection(peer(1)), {
    code: CONTROL_CODES.LIMIT,
  });
  const queries = connections.map((connection) => connection.beginQuery());
  assert.throws(() => connections[0]!.beginQuery(), {
    code: CONTROL_CODES.LIMIT,
  });
  queries[0]!.finish();
  connections[0]!.beginQuery().cancel();
  connections.forEach((connection) => connection.close());
  const next = admission.openConnection(peer(1));
  next.beginQuery().finish();
  next.close();
});
void test('control query deadline is absolute while connection idle deadlines are independent', () => {
  let now = 0;
  const admission = new ControlAdmission(() => now);
  const connection = admission.openConnection(peer(1));
  now = CONTROL_CAPACITY.connectionIdleMs - 1;
  const query = connection.beginQuery();
  now += CONTROL_CAPACITY.queryMs - 1;
  query.check();
  now++;
  assert.throws(() => query.publish('late'), { code: CONTROL_CODES.CANCELLED });
  const fresh = connection.beginQuery();
  fresh.cancel();
  assert.throws(() => fresh.publish('cancelled'), {
    code: CONTROL_CODES.CANCELLED,
  });
  now += CONTROL_CAPACITY.connectionIdleMs;
  assert.throws(() => connection.beginQuery(), {
    code: CONTROL_CODES.CANCELLED,
  });
});
void test('control rate limits count repeated and malformed attempts before parsing and refill by time', () => {
  let now = 0;
  const admission = new ControlAdmission(() => now);
  const connection = admission.openConnection(peer(1));
  for (let index = 0; index < CONTROL_CAPACITY.peerBurst; index++)
    connection.beginQuery().cancel();
  assert.throws(() => connection.beginQuery(), { code: CONTROL_CODES.LIMIT });
  now += CONTROL_CAPACITY.millisecondsPerSecond / CONTROL_CAPACITY.peerRate;
  connection.beginQuery().finish();
  now--;
  assert.throws(() => connection.check(), { code: CONTROL_CODES.INVALID });
});
void test('control enforces global rate and concurrency limits across distinct peers', () => {
  const admission = new ControlAdmission(() => 0);
  const connections = Array.from(
    { length: CONTROL_CAPACITY.connections },
    (_, index) => admission.openConnection(peer(index)),
  );
  assert.throws(() => admission.openConnection(peer(99)), {
    code: CONTROL_CODES.LIMIT,
  });
  const queries = connections.map((connection) => connection.beginQuery());
  assert.throws(() => connections[0]!.beginQuery(), {
    code: CONTROL_CODES.LIMIT,
  });
  queries.forEach((query) => query.finish());
  for (
    let index = CONTROL_CAPACITY.connections + 1;
    index < CONTROL_CAPACITY.globalBurst;
    index++
  )
    connections[index % connections.length]!.beginQuery().finish();
  assert.throws(() => connections[0]!.beginQuery(), {
    code: CONTROL_CODES.LIMIT,
  });
});
void test('control bounds peer accounting without evicting active peers and expires idle entries', () => {
  let now = 0;
  const admission = new ControlAdmission(() => now);
  const active = admission.openConnection(peer(0));
  for (let index = 1; index < CONTROL_CAPACITY.peers; index++)
    admission.openConnection(peer(index)).close();
  assert.throws(() => admission.openConnection(peer(CONTROL_CAPACITY.peers)), {
    code: CONTROL_CODES.LIMIT,
  });
  active.check();
  now += CONTROL_CAPACITY.peerIdleMs;
  admission.openConnection(peer(CONTROL_CAPACITY.peers)).close();
});
