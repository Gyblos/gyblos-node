// Own-child readiness uses synthetic IPC, no sockets; CONNECT cannot consume its budget during startup.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { EndpointAddr } from '@number0/iroh';

import { NativeTestDeadlineError } from './support/native-fixture';
import { unreadPeer } from './support/native-reader';
import {
  READER_ACTIONS,
  READER_STARTUP,
  type ReaderAction,
} from './support/native-reader-constants';
import { waitForReaderReady } from './support/native-reader-ready';

class ReaderDouble extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  commands: ReaderAction[] = [];
  replyToConnect = true;
  send(
    value: { id: number; action: ReaderAction },
    done: (error: Error | null) => void,
  ) {
    this.commands.push(value.action);
    done(null);
    if (value.action === READER_ACTIONS.CONNECT && !this.replyToConnect)
      return true;
    queueMicrotask(() => {
      this.emit('message', { id: value.id, ok: true, nodeId: 'a'.repeat(64) });
      if (value.action === READER_ACTIONS.SHUTDOWN) {
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }
    });
    return true;
  }
  kill(signal: NodeJS.Signals) {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  }
  ready() {
    this.emit('message', { kind: READER_STARTUP.ready });
  }
}
const target = {
  id: () => ({ toString: () => 'b'.repeat(64) }),
  directAddresses: () => [],
} as unknown as EndpointAddr;
void test('unread peer waits for READY beyond the old connection preparation budget', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new ReaderDouble();
  const opening = unreadPeer(target, {
    spawn: () => child as unknown as ChildProcess,
  });
  try {
    await Promise.resolve();
    context.mock.timers.tick(4000);
    assert.deepEqual(child.commands, []);
    child.ready();
    const peer = await opening;
    assert.deepEqual(child.commands, [READER_ACTIONS.CONNECT]);
    await peer.close();
  } finally {
    child.ready();
    const peer = await opening.catch(() => undefined);
    await peer?.close();
  }
});

void test('a missing READY expires, kills only the owned child and cannot issue a late CONNECT', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new ReaderDouble();
  const opening = unreadPeer(target, {
    spawn: () => child as unknown as ChildProcess,
  });
  const refused = assert.rejects(opening, NativeTestDeadlineError);
  context.mock.timers.tick(READER_STARTUP.milliseconds);
  await refused;
  assert.deepEqual(child.commands, []);
  assert.equal(child.signalCode, 'SIGTERM');
  child.ready();
  assert.deepEqual(child.commands, []);
});
void test('a child exiting before READY rejects promptly without trying a connection', async () => {
  const child = new ReaderDouble();
  const opening = unreadPeer(target, {
    spawn: () => child as unknown as ChildProcess,
  });
  const refused = assert.rejects(opening, /before readiness/);
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await refused;
  assert.deepEqual(child.commands, []);
});
void test('READY validation ignores malformed messages and removes startup listeners', async () => {
  const child = new ReaderDouble();
  let ready = false;
  const starting = waitForReaderReady(child as unknown as ChildProcess).then(
    () => {
      ready = true;
    },
  );
  for (const value of [
    null,
    'ready',
    { kind: READER_STARTUP.ready, extra: true },
    { id: 1, ok: true },
  ])
    child.emit('message', value);
  await Promise.resolve();
  assert.equal(ready, false);
  child.ready();
  await starting;
  for (const event of ['message', 'error', 'exit'])
    assert.equal(child.listenerCount(event), 0);
});
void test('CONNECT retains its own original deadline after a successful READY', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new ReaderDouble();
  child.replyToConnect = false;
  const opening = unreadPeer(target, {
    spawn: () => child as unknown as ChildProcess,
  });
  const refused = assert.rejects(opening, NativeTestDeadlineError);
  context.mock.timers.tick(4000);
  child.ready();
  await Promise.resolve();
  assert.deepEqual(child.commands, [READER_ACTIONS.CONNECT]);
  context.mock.timers.tick(3500);
  await refused;
  assert.deepEqual(child.commands, [
    READER_ACTIONS.CONNECT,
    READER_ACTIONS.SHUTDOWN,
  ]);
  assert.equal(child.exitCode, 0);
});
