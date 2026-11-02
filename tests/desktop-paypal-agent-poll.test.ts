import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentStatusPoll } from '@gyblos/desktop/paypal-agent-model';

void test('a timed-out status is discarded while a new bounded check can recover', async () => {
  let calls = 0;
  const updates: string[] = [];
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
      return calls === 1 ? pending : 'fresh';
    },
    (value) => {
      updates.push(value);
      received(value);
    },
    timedOut,
    15,
  );
  poll.poll();
  poll.poll();
  await deadline;
  assert.equal(calls, 1);
  assert.equal(poll.isStalled(), true);
  try {
    poll.poll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(await finished, 'fresh');
    release('outdated');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, ['fresh']);
    assert.equal(poll.isStalled(), false);
  } finally {
    release('outdated');
    poll.stop();
  }
});

void test('a stuck status channel cannot create unbounded pending requests', async () => {
  let calls = 0;
  let timeouts = 0;
  let first = () => {};
  let second = () => {};
  const firstTimeout = new Promise<void>((resolve) => {
    first = resolve;
  });
  const secondTimeout = new Promise<void>((resolve) => {
    second = resolve;
  });
  const poll = createPaypalAgentStatusPoll(
    () => {
      calls += 1;
      return new Promise<string>(() => {});
    },
    () => {},
    () => {
      timeouts += 1;
      if (timeouts === 1) first();
      if (timeouts === 2) second();
    },
    15,
  );
  poll.poll();
  await firstTimeout;
  poll.poll();
  await secondTimeout;
  poll.poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(poll.isStalled(), true);
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

void test('starting a poll records its request before a later disconnect can invalidate it', () => {
  const events: string[] = [];
  const poll = createPaypalAgentStatusPoll(
    async () => { events.push('status started'); return 'synthetic'; },
    () => {},
    () => {},
    15,
  );
  poll.poll();
  events.push('disconnect started');
  assert.deepEqual(events, ['status started', 'disconnect started']);
  poll.stop();
});
