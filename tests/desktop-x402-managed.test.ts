// Utility lifecycle is exercised without native processes or private configuration.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ManagedBuyer } from '@gyblos/desktop/x402-managed';
import { BUYER_SIDECAR } from '@gyblos/protocol/buyer-api';

class Worker extends EventEmitter {
  sent: string[] = [];
  killed = 0;
  postMessage(message: string) {
    this.sent.push(message);
  }
  kill() {
    this.killed++;
  }
}
void test('managed buyer cannot start twice and waits for actual exit before closing', async () => {
  const worker = new Worker();
  let disconnected = 0;
  const buyer = new ManagedBuyer(
    () => worker,
    () => {
      disconnected++;
    },
  );
  const opening = buyer.start(
    '/tmp/synthetic-buyer-home',
    'synthetic-relay-token',
  );
  await assert.rejects(() => buyer.start('/tmp/another-home', 'other-token'));
  worker.emit('spawn');
  worker.emit('message', {
    kind: BUYER_SIDECAR.READY,
    url: 'http://127.0.0.1:8090/v1/chat/completions',
    token: 'synthetic-private-bearer',
  });
  assert.equal((await opening).token, 'synthetic-private-bearer');
  let closed = false;
  const closing = buyer.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.deepEqual(worker.sent, [BUYER_SIDECAR.STOP]);
  worker.emit('exit', 0);
  await closing;
  assert.equal(disconnected, 1);
  await assert.rejects(() => buyer.start('/tmp/another-home', 'other-token'));
});
void test('stopping during startup ignores a late ready credential', async () => {
  const worker = new Worker();
  const buyer = new ManagedBuyer(
    () => worker,
    () => {},
  );
  const opening = buyer.start(
    '/tmp/synthetic-buyer-home',
    'synthetic-relay-token',
  );
  const rejected = assert.rejects(opening);
  const closing = buyer.close();
  worker.emit('spawn');
  worker.emit('message', {
    kind: BUYER_SIDECAR.READY,
    url: 'http://127.0.0.1:8090/v1/chat/completions',
    token: 'late-private-bearer',
  });
  worker.emit('exit', 0);
  await rejected;
  await closing;
  assert.deepEqual(worker.sent, [BUYER_SIDECAR.STOP]);
});
void test('malformed sidecar messages fail without releasing a running process early', async () => {
  const worker = new Worker();
  const buyer = new ManagedBuyer(
    () => worker,
    () => {},
  );
  const opening = buyer.start(
    '/tmp/synthetic-buyer-home',
    'synthetic-relay-token',
  );
  const rejected = assert.rejects(opening);
  worker.emit('message', { kind: BUYER_SIDECAR.READY, token: 'missing-url' });
  await rejected;
  assert.equal(worker.killed, 1);
  await assert.rejects(() => buyer.start('/tmp/another-home', 'other-token'));
  worker.emit('exit', 1);
  await buyer.close();
});
