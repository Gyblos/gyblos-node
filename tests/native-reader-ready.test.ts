// Own-child readiness uses synthetic IPC, no sockets; CONNECT cannot consume its budget during startup.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { EndpointAddr } from '@number0/iroh';

import { unreadPeer } from './support/native-reader';
import { READER_ACTIONS, READER_STARTUP } from './support/native-reader-constants';

class ReaderDouble extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  commands: string[] = [];
  send(value: { id: number; action: string }, done: (error: Error | null) => void) {
    this.commands.push(value.action);
    done(null);
    queueMicrotask(() => {
      this.emit('message', { id: value.id, ok: true, nodeId: 'a'.repeat(64) });
      if (value.action === READER_ACTIONS.SHUTDOWN) { this.exitCode = 0; this.emit('exit', 0, null); }
    });
    return true;
  }
  kill(signal: NodeJS.Signals) { this.signalCode = signal; this.emit('exit', null, signal); return true; }
  ready() { this.emit('message', { kind: READER_STARTUP.ready }); }
}
const target = { id: () => ({ toString: () => 'b'.repeat(64) }), directAddresses: () => [] } as unknown as EndpointAddr;
void test('unread peer waits for READY beyond the old connection preparation budget', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new ReaderDouble();
  const opening = unreadPeer(target, { spawn: () => child as unknown as ChildProcess });
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
