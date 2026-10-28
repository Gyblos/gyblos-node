// Verifies native runtime ordering with injected resources; no sockets or private state.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runLocalNode, type LocalNodePort } from '@gyblos/desktop/node-runtime';
import { LOCAL_NODE } from '@gyblos/desktop/node-status';

function portFixture() {
  let receive = (_event: { data: unknown }) => {};
  const messages: string[] = [];
  const port: LocalNodePort = {
    on(_event, listener) { receive = listener; },
    postMessage(message) { messages.push(message); },
  };
  return { port, messages, stop: () => receive({ data: LOCAL_NODE.STOP }) };
}
void test('local runtime reports readiness only after binding and closes before successful exit', async () => {
  const { port, messages, stop } = portFixture();
  let bind = (_resource: { close(): Promise<void> }) => {};
  let closed = false;
  let code: number | undefined;
  const pending = runLocalNode(port, () => new Promise((resolve) => { bind = resolve; }), (value) => { code = value; });
  await Promise.resolve();
  assert.deepEqual(messages, []);
  bind({ async close() { closed = true; } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [LOCAL_NODE.READY]);
  assert.equal(code, undefined);
  stop(); await pending;
  assert.equal(closed, true); assert.equal(code, 0);
});
void test('local runtime cancellation while binding suppresses late readiness and awaits close', async () => {
  const { port, messages, stop } = portFixture();
  let bind = (_resource: { close(): Promise<void> }) => {};
  let finishClose = () => {};
  let code: number | undefined;
  const pending = runLocalNode(port, () => new Promise((resolve) => { bind = resolve; }), (value) => { code = value; });
  await Promise.resolve(); stop();
  bind({ close: () => new Promise<void>((resolve) => { finishClose = resolve; }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, []); assert.equal(code, undefined);
  finishClose(); await pending; assert.equal(code, 0);
});
void test('local runtime native failures are not forwarded and never exit successfully', async () => {
  const { port, messages } = portFixture();
  let code: number | undefined;
  await runLocalNode(port, async () => { throw new Error('synthetic secret native detail'); }, (value) => { code = value; });
  assert.deepEqual(messages, []); assert.equal(code, 1);
  const failedClose = portFixture();
  const pending = runLocalNode(failedClose.port, async () => ({ async close() { throw new Error('private close'); } }), (value) => { code = value; });
  failedClose.stop(); await pending; assert.equal(code, 1);
});
