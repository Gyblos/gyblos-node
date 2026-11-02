import assert from 'node:assert/strict';
import { test } from 'node:test';

import { waitForPaypalAgentServerClose } from '@gyblos/desktop/paypal-agent-server';

void test('an already closed server still waits for dispatched requests to drain', async () => {
  let release = () => {};
  let drained = false;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const closed = waitForPaypalAgentServerClose(
    (done) => done(Object.assign(new Error('already closed'), { code: 'ERR_SERVER_NOT_RUNNING' })),
    async () => { await waiting; drained = true; },
  );
  let returned = false;
  const finished = closed.then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false);
  release();
  await finished;
  assert.equal(drained, true);
});

void test('an unexpected server close failure is not presented as a successful disconnect', async () => {
  await assert.rejects(waitForPaypalAgentServerClose(
    (done) => done(new Error('unexpected failure')),
    async () => {},
  ));
});
