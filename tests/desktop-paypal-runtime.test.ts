// Exercises lazy startup and safe shutdown without Electron, network or private state.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalRuntime } from '@gyblos/desktop/paypal-runtime';

void test('selection does not start PayPal and concurrent requests share one startup', async () => {
  let starts = 0;
  let stops = 0;
  const value = {
    model: 'synthetic',
    service: {
      close: async () => {
        stops++;
      },
    },
  };
  const runtime = createDesktopPaypalRuntime(async () => {
    starts++;
    return value;
  });
  assert.equal(starts, 0);
  const [first, second] = await Promise.all([runtime.load(), runtime.load()]);
  assert.equal(first, value);
  assert.equal(second, value);
  assert.equal(starts, 1);
  await runtime.close();
  assert.equal(stops, 1);
  await assert.rejects(runtime.load());
});

void test('a failed setup can be checked again without creating a payment', async () => {
  let starts = 0;
  const value = { model: 'synthetic', service: { close: async () => {} } };
  const runtime = createDesktopPaypalRuntime(async () => {
    starts++;
    if (starts === 1) throw new Error('synthetic unavailable');
    return value;
  });
  await assert.rejects(runtime.load());
  assert.equal(await runtime.load(), value);
  assert.equal(starts, 2);
  await runtime.close();
});

void test('shutdown waits for an opening session and closes it exactly once', async () => {
  let release: (() => void) | undefined;
  let stops = 0;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createDesktopPaypalRuntime(async () => {
    await ready;
    return {
      model: 'synthetic',
      service: {
        close: async () => {
          stops++;
        },
      },
    };
  });
  const opening = runtime.load();
  const closing = runtime.close();
  assert.equal(stops, 0);
  assert.ok(release);
  release();
  await opening;
  await closing;
  await runtime.close();
  assert.equal(stops, 1);
});
