// Exercises bounded status polling with synthetic sandbox services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import { PAYPAL_ACTION, type PaypalResult } from '@gyblos/desktop/paypal-model';

import { setup } from './support/desktop-paypal-chat-fixture';

void test('a known unfinished session remains discoverable after refresh failure until confirmed closed', async () => {
  const { run } = await setup();
  let failStatus = false;
  const chat = new PaypalChatController(async (request) => {
    if (failStatus && request.action === PAYPAL_ACTION.STATUS)
      throw new Error('Synthetic unavailable status');
    return run(request);
  });
  assert.equal(chat.hasKnownUnfinishedSession(), false);
  await chat.refresh();
  assert.equal(chat.hasKnownUnfinishedSession(), false);
  await chat.create();
  await chat.approve();
  assert.equal(chat.hasKnownUnfinishedSession(), true);
  failStatus = true;
  await chat.refresh();
  assert.equal(chat.getSnapshot().status, null);
  assert.equal(chat.getSnapshot().statusFresh, false);
  assert.equal(chat.hasKnownUnfinishedSession(), true);
  chat.stopMonitoring();
  assert.equal(chat.hasKnownUnfinishedSession(), true);
  failStatus = false;
  chat.startMonitoring();
  await chat.refresh();
  await chat.finish();
  assert.equal(chat.hasKnownUnfinishedSession(), false);
});

void test('stopping monitoring invalidates status and ignores an outstanding poll', async () => {
  const { run } = await setup();
  let release: ((result: PaypalResult) => void) | undefined;
  let stall = false;
  const chat = new PaypalChatController(async (request) => {
    if (stall && request.action === 'status')
      return new Promise<PaypalResult>((resolve) => {
        release = resolve;
      });
    return run(request);
  });
  await chat.refresh();
  const old = await run({ action: 'status' });
  assert.equal(chat.getSnapshot().statusFresh, true);
  stall = true;
  const pending = chat.poll();
  chat.stopMonitoring();
  assert.equal(chat.getSnapshot().statusFresh, false);
  assert.ok(release);
  release(old);
  await pending;
  assert.equal(chat.getSnapshot().statusFresh, false);
});

void test('refresh makes an earlier status unavailable until the new check finishes', async () => {
  const { run } = await setup();
  let release: ((result: PaypalResult) => void) | undefined;
  let stall = false;
  const chat = new PaypalChatController(async (request) => {
    if (stall && request.action === 'status')
      return new Promise<PaypalResult>((resolve) => {
        release = resolve;
      });
    return run(request);
  });
  await chat.refresh();
  const old = await run({ action: 'status' });
  stall = true;
  const pending = chat.refresh();
  assert.equal(chat.getSnapshot().statusFresh, false);
  assert.ok(release);
  release(old);
  await pending;
  assert.equal(chat.getSnapshot().statusFresh, true);
});

void test('a refresh from before monitoring stopped cannot restore an old status', async () => {
  const { run } = await setup();
  let release: ((result: PaypalResult) => void) | undefined;
  let stall = false;
  const chat = new PaypalChatController(async (request) => {
    if (stall && request.action === 'status')
      return new Promise<PaypalResult>((resolve) => {
        release = resolve;
      });
    return run(request);
  });
  await chat.refresh();
  const old = await run({ action: 'status' });
  stall = true;
  const pending = chat.refresh();
  chat.stopMonitoring();
  chat.startMonitoring();
  assert.ok(release);
  release(old);
  await pending;
  assert.equal(chat.getSnapshot().statusFresh, false);
  stall = false;
  await chat.refresh();
  assert.equal(chat.getSnapshot().statusFresh, true);
});

void test('a return queued during a stale refresh is processed exactly once', async () => {
  const { f, run, service, states } = await setup();
  let release: (() => void) | undefined;
  let stall = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = new PaypalChatController(async (request) => {
    const result = await run(request);
    if (stall && request.action === 'status') await waiting;
    return result;
  });
  await chat.refresh();
  await chat.startCheckout();
  stall = true;
  const pending = chat.refresh();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await chat.returnedFromPaypal();
  chat.stopMonitoring();
  chat.startMonitoring();
  assert.ok(release);
  release();
  await pending;
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

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
