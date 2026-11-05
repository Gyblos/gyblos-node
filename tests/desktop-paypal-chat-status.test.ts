// Exercises bounded status polling with synthetic sandbox services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import type { PaypalResult } from '@gyblos/desktop/paypal-model';

import { setup } from './support/desktop-paypal-chat-fixture';

void test('a stalled status check becomes unavailable, recovers, and ignores a late result', async () => {
  const { f, run } = await setup();
  let stalled = false;
  let release: ((result: PaypalResult) => void) | undefined;
  const chat = new PaypalChatController(async (request) => {
    if (stalled && request.action === 'status')
      return new Promise<PaypalResult>((resolve) => {
        release = resolve;
      });
    return run(request);
  }, 15);
  await chat.refresh();
  await chat.create();
  await chat.approve();
  const oldResult = await run({ action: 'status' });
  assert.ok(oldResult.status);
  stalled = true;
  const pending = chat.poll();
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    assert.equal(chat.getSnapshot().statusFresh, false);
    chat.setDraft('Hello');
    await chat.send();
    await chat.finish();
    assert.deepEqual(f.calls, ['create', 'authorize']);
    stalled = false;
    await chat.poll();
    assert.equal(chat.getSnapshot().statusFresh, true);
    assert.ok(release);
    release({ ...oldResult, status: { ...oldResult.status, spentCents: 40 } });
    await pending;
    assert.equal(chat.getSnapshot().status?.spentCents, 0);
  } finally {
    release?.(oldResult);
    await pending;
  }
});

void test('stalled status checks stay bounded and a later manual check can recover', async () => {
  const { run } = await setup();
  const releases: Array<(result: PaypalResult) => void> = [];
  let stalled = false;
  const chat = new PaypalChatController(async (request) => {
    if (stalled && request.action === 'status')
      return new Promise<PaypalResult>((resolve) => releases.push(resolve));
    return run(request);
  }, 15);
  await chat.refresh();
  const previous = await run({ action: 'status' });
  stalled = true;
  await chat.poll();
  await chat.poll();
  await chat.poll();
  assert.equal(releases.length, 2);
  assert.equal(chat.getSnapshot().statusFresh, false);
  for (const release of releases) release(previous);
  await new Promise<void>((resolve) => setImmediate(resolve));
  stalled = false;
  await chat.refresh();
  assert.equal(chat.getSnapshot().statusFresh, true);
});
