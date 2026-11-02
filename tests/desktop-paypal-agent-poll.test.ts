import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentStatusPoll } from '@gyblos/desktop/paypal-agent-model';

void test('a slow status check cannot overlap and becomes unknown until it completes', async () => {
  let calls = 0;
  let release = (_value: string) => {};
  let timedOut = () => {};
  let received = (_value: string) => {};
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const deadline = new Promise<void>((resolve) => {
    timedOut = resolve;
  });
  const finished = new Promise<string>((resolve) => {
    received = resolve;
  });
  const poll = createPaypalAgentStatusPoll(
    async () => {
      calls += 1;
      return pending;
    },
    received,
    timedOut,
    15,
  );
  poll.poll();
  poll.poll();
  await deadline;
  assert.equal(calls, 1);
  assert.equal(poll.isStalled(), true);
  poll.poll();
  assert.equal(calls, 1);
  release('fresh');
  assert.equal(await finished, 'fresh');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(poll.isStalled(), false);
  poll.poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  poll.stop();
});

void test('stopping a status poll prevents late updates', async () => {
  let release = (_value: string) => {};
  let updates = 0;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const poll = createPaypalAgentStatusPoll(
    () => pending,
    () => {
      updates += 1;
    },
    () => {
      updates += 1;
    },
    15,
  );
  poll.poll();
  poll.stop();
  release('late');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(updates, 0);
});
