// Exercises local-node lifecycle and the fixed status bridge without native sockets or wallets.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createNodeHandlers } from '@gyblos/desktop/node-handlers';
import { createDesktopNodeSession } from '@gyblos/desktop/node-session';
import {
  LOCAL_NODE,
  LOCAL_NODE_STATE,
  parseLocalNodeState,
} from '@gyblos/desktop/node-status';

class Worker extends EventEmitter {
  killed = 0;
  sent: string[] = [];
  kill() {
    this.killed += 1;
    return true;
  }
  postMessage(message: string) {
    this.sent.push(message);
  }
}
function workerAt(workers: Worker[], index: number) {
  const worker = workers[index];
  assert.ok(worker);
  return worker;
}
function fixture() {
  const controller = new AbortController();
  const workers: Worker[] = [];
  const session = createDesktopNodeSession(() => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  }, controller.signal);
  return { session, workers, controller };
}
void test('local node readiness requires a worker acknowledgement and never a timer', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, workers } = fixture();
  session.start();
  assert.equal(session.summary(), LOCAL_NODE_STATE.STARTING);
  context.mock.timers.tick(1000);
  assert.equal(session.summary(), LOCAL_NODE_STATE.STARTING);
  workerAt(workers, 0).emit('spawn');
  workerAt(workers, 0).emit('message', LOCAL_NODE.READY);
  assert.equal(session.summary(), LOCAL_NODE_STATE.READY);
  const closing = session.close();
  workerAt(workers, 0).emit('exit', 0);
  await closing;
});
void test('local node coalesces retries and cannot restart before the failed worker exits', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, workers } = fixture();
  session.start();
  session.start();
  assert.equal(workers.length, 1);
  workerAt(workers, 0).emit('spawn');
  workerAt(workers, 0).emit('message', { error: 'synthetic private endpoint' });
  assert.equal(session.summary(), LOCAL_NODE_STATE.ERROR);
  session.start();
  assert.equal(workers.length, 1);
  workerAt(workers, 0).emit('exit', 1);
  session.start();
  assert.equal(workers.length, 2);
  workerAt(workers, 1).emit('spawn');
  workerAt(workers, 1).emit('message', LOCAL_NODE.READY);
  workerAt(workers, 0).emit('message', LOCAL_NODE.READY);
  assert.equal(session.summary(), LOCAL_NODE_STATE.READY);
  const closing = session.close();
  workerAt(workers, 1).emit('exit', 0);
  await closing;
});
void test('local node exit is visible and retry creates one fresh worker', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, workers } = fixture();
  session.start();
  workerAt(workers, 0).emit('spawn');
  workerAt(workers, 0).emit('message', LOCAL_NODE.READY);
  workerAt(workers, 0).emit('exit', 0);
  assert.equal(session.summary(), LOCAL_NODE_STATE.ERROR);
  session.start();
  session.start();
  assert.equal(workers.length, 2);
  const closing = session.close();
  workerAt(workers, 1).emit('spawn');
  workerAt(workers, 1).emit('exit', 0);
  await closing;
});
void test('local node quit before spawn ignores late readiness and waits for process exit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, workers, controller } = fixture();
  session.start();
  controller.abort();
  let finished = false;
  const closing = session.close().then(() => {
    finished = true;
  });
  workerAt(workers, 0).emit('spawn');
  assert.deepEqual(workerAt(workers, 0).sent, [LOCAL_NODE.STOP]);
  workerAt(workers, 0).emit('message', LOCAL_NODE.READY);
  assert.equal(session.summary(), LOCAL_NODE_STATE.STOPPING);
  await Promise.resolve();
  assert.equal(finished, false);
  workerAt(workers, 0).emit('exit', 0);
  await closing;
  assert.equal(finished, true);
  assert.equal(session.summary(), LOCAL_NODE_STATE.STOPPED);
  session.start();
  assert.equal(workers.length, 1);
});
void test('local node startup timeout and forced shutdown wait for actual worker exit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, workers } = fixture();
  session.start();
  context.mock.timers.tick(LOCAL_NODE.START_TIMEOUT_MS);
  assert.equal(session.summary(), LOCAL_NODE_STATE.ERROR);
  assert.equal(workerAt(workers, 0).killed, 1);
  workerAt(workers, 0).emit('spawn');
  assert.equal(workerAt(workers, 0).killed, 2);
  let finished = false;
  const closing = session.close().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  workerAt(workers, 0).emit('exit', 1);
  await closing;
  assert.equal(session.summary(), LOCAL_NODE_STATE.ERROR);
});
void test('local node graceful shutdown falls back to termination without claiming a clean stop', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, workers } = fixture();
  session.start();
  workerAt(workers, 0).emit('spawn');
  workerAt(workers, 0).emit('message', LOCAL_NODE.READY);
  const closing = session.close();
  context.mock.timers.tick(LOCAL_NODE.STOP_TIMEOUT_MS);
  assert.equal(workerAt(workers, 0).killed, 1);
  workerAt(workers, 0).emit('exit', 0);
  await closing;
  assert.equal(session.summary(), LOCAL_NODE_STATE.ERROR);
});
void test('local node never starts after cancellation and sanitizes fork failures', async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = createDesktopNodeSession(() => {
    throw new Error('must not fork');
  }, controller.signal);
  cancelled.start();
  assert.equal(cancelled.summary(), LOCAL_NODE_STATE.STOPPED);
  await cancelled.close();
  const failed = createDesktopNodeSession(() => {
    throw new Error('synthetic private path');
  }, new AbortController().signal);
  failed.start();
  assert.equal(failed.summary(), LOCAL_NODE_STATE.ERROR);
  await failed.close();
});
void test('local node status boundary rejects payloads containing identities, addresses or extra data', () => {
  for (const value of [
    null,
    {},
    [],
    'connected',
    { state: LOCAL_NODE_STATE.READY, address: 'private' },
  ])
    assert.equal(parseLocalNodeState(value), LOCAL_NODE_STATE.ERROR);
  for (const value of Object.values(LOCAL_NODE_STATE))
    assert.equal(parseLocalNodeState(value), value);
});
void test('local node bridge rejects foreign windows, stale frames, extra arguments and absent sessions', () => {
  const contents = {};
  let frame = {};
  let destroyed = false;
  let starts = 0;
  const handlers = createNodeHandlers(
    {
      summary: () => LOCAL_NODE_STATE.STOPPED,
      start: () => {
        starts += 1;
      },
    },
    { contents, mainFrame: () => frame, destroyed: () => destroyed },
  );
  const event = { sender: contents, senderFrame: frame };
  assert.equal(handlers.summary(event, []), LOCAL_NODE_STATE.STOPPED);
  handlers.retry({ sender: {}, senderFrame: frame }, []);
  handlers.retry(event, ['extra']);
  frame = {};
  handlers.retry(event, []);
  destroyed = true;
  handlers.retry({ sender: contents, senderFrame: frame }, []);
  assert.equal(starts, 0);
  destroyed = false;
  handlers.retry({ sender: contents, senderFrame: frame }, []);
  assert.equal(starts, 1);
  assert.equal(
    createNodeHandlers(null, {
      contents,
      mainFrame: () => frame,
      destroyed: () => false,
    }).summary(event, []),
    LOCAL_NODE_STATE.ERROR,
  );
});
