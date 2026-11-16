// Synthetic clocks cover repeated checks and lifecycle cleanup without network, wallets or sleeping.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { DesktopUpdate } from '@gyblos/desktop/update-check';
import {
  createDesktopUpdateReader,
  observeDesktopUpdates,
} from '@gyblos/desktop/update-session';

const current = '0.1.0-beta.11';
const unchanged: DesktopUpdate = { current, available: null };
const newer: DesktopUpdate = { current, available: '0.1.0-beta.12' };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

void test('desktop update reads at launch and sees a new release exactly five minutes later', async () => {
  let now = 0;
  let reads = 0;
  const read = createDesktopUpdateReader(
    current,
    async () => (++reads === 1 ? unchanged : newer),
    () => now,
  );
  assert.deepEqual(await read(), unchanged);
  assert.equal(reads, 1);
  now = 299999;
  assert.deepEqual(await read(), unchanged);
  assert.equal(reads, 1);
  now = 300000;
  assert.deepEqual(await read(), newer);
  assert.equal(reads, 2);
});

void test('desktop update concurrent status requests share the same in-flight check', async () => {
  let reads = 0;
  let complete = (_result: DesktopUpdate) => {};
  const pending = new Promise<DesktopUpdate>((resolve) => {
    complete = resolve;
  });
  const read = createDesktopUpdateReader(current, async () => {
    reads++;
    return pending;
  });
  try {
    const first = read();
    const second = read();
    await flush();
    assert.equal(reads, 1);
    complete(newer);
    assert.deepEqual(await Promise.all([first, second]), [newer, newer]);
  } finally {
    complete(unchanged);
  }
});

void test('desktop update failed checks remain silent and retry on the next interval', async () => {
  let now = 0;
  let reads = 0;
  const read = createDesktopUpdateReader(
    current,
    async () => {
      if (++reads === 1) throw new Error('synthetic offline');
      return newer;
    },
    () => now,
  );
  assert.deepEqual(await read(), unchanged);
  assert.equal(reads, 1);
  now = 299999;
  assert.deepEqual(await read(), unchanged);
  assert.equal(reads, 1);
  now = 300000;
  assert.deepEqual(await read(), newer);
  assert.equal(reads, 2);
});

void test('desktop update observer refreshes an already open window every five minutes', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  const displayed: DesktopUpdate[] = [];
  const stop = observeDesktopUpdates(
    async () => (++reads === 1 ? unchanged : newer),
    (update) => displayed.push(update),
  );
  try {
    await flush();
    assert.deepEqual(displayed, [unchanged]);
    context.mock.timers.tick(299999);
    await flush();
    assert.equal(reads, 1);
    context.mock.timers.tick(1);
    await flush();
    assert.deepEqual(displayed, [unchanged, newer]);
    assert.equal(reads, 2);
  } finally {
    stop();
  }
});

void test('desktop update observer never overlaps a stalled status check', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  let complete = (_result: DesktopUpdate) => {};
  const pending = new Promise<DesktopUpdate>((resolve) => {
    complete = resolve;
  });
  const stop = observeDesktopUpdates(
    async () => {
      reads++;
      return pending;
    },
    () => {},
  );
  try {
    await flush();
    assert.equal(reads, 1);
    context.mock.timers.tick(600000);
    await flush();
    assert.equal(reads, 1);
    complete(newer);
    await flush();
    context.mock.timers.tick(300000);
    await flush();
    assert.equal(reads, 2);
  } finally {
    stop();
    complete(unchanged);
  }
});

void test('desktop update observer cleanup removes the timer and ignores late results', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  let complete = (_result: DesktopUpdate) => {};
  const pending = new Promise<DesktopUpdate>((resolve) => {
    complete = resolve;
  });
  const displayed: DesktopUpdate[] = [];
  const stop = observeDesktopUpdates(
    async () => {
      reads++;
      return pending;
    },
    (update) => displayed.push(update),
  );
  await flush();
  assert.equal(reads, 1);
  stop();
  complete(newer);
  await flush();
  context.mock.timers.tick(900000);
  await flush();
  assert.equal(reads, 1);
  assert.deepEqual(displayed, []);
});

void test('desktop update observer recovers from an offline startup without blocking the window', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  const displayed: DesktopUpdate[] = [];
  const stop = observeDesktopUpdates(
    async () => {
      if (++reads === 1) throw new Error('synthetic offline');
      return newer;
    },
    (update) => displayed.push(update),
  );
  try {
    await flush();
    assert.equal(reads, 1);
    assert.deepEqual(displayed, []);
    context.mock.timers.tick(300000);
    await flush();
    assert.equal(reads, 2);
    assert.deepEqual(displayed, [newer]);
  } finally {
    stop();
  }
});
