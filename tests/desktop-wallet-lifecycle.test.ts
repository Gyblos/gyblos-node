// Reproduces first-start and orderly-close races without Electron or OS secrets.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  focusExistingWindow,
  prepareWalletProfile,
  waitForWalletBeforeQuit,
} from '@gyblos/desktop/wallet';

void test('desktop second launch ignores a destroyed window during deferred quit', async () => {
  let finish: (() => void) | undefined;
  let quits = 0;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const beforeQuit = waitForWalletBeforeQuit(pending, () => {
    quits += 1;
  });
  beforeQuit({ preventDefault() {} });
  const destroyed = {
    isDestroyed: () => true,
    isMinimized: () => {
      throw new Error('Object has been destroyed');
    },
    restore: () => {
      throw new Error('Object has been destroyed');
    },
    focus: () => {
      throw new Error('Object has been destroyed');
    },
  };
  assert.doesNotThrow(() => focusExistingWindow(destroyed));
  assert.equal(quits, 0);
  finish!();
  await pending;
  await Promise.resolve();
  assert.equal(quits, 1);
});

void test('desktop second launch still restores and focuses an existing live window', () => {
  const calls: string[] = [];
  focusExistingWindow({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => {
      calls.push('restore');
    },
    focus: () => {
      calls.push('focus');
    },
  });
  assert.deepEqual(calls, ['restore', 'focus']);
});

void test('desktop creates its persistent profile before Electron setPath can use it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-wallet-profile-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'fresh-profile');
  prepareWalletProfile(profile);
  assert.equal((await stat(profile)).isDirectory(), true);
  prepareWalletProfile(profile);
  assert.equal((await stat(profile)).isDirectory(), true);
});

void test('desktop close waits for delayed wallet initialization without duplicate quits', async () => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let quits = 0;
  let prevented = 0;
  const beforeQuit = waitForWalletBeforeQuit(pending, () => {
    quits += 1;
  });
  const event = {
    preventDefault() {
      prevented += 1;
    },
  };
  beforeQuit(event);
  beforeQuit(event);
  assert.equal(quits, 0);
  assert.equal(prevented, 2);
  finish!();
  await pending;
  await Promise.resolve();
  assert.equal(quits, 1);
  beforeQuit(event);
  assert.equal(prevented, 2);
});

void test('desktop failed initialization still releases an orderly quit without leaking an error', async () => {
  let quits = 0;
  const pending = Promise.reject(new Error('synthetic-private-error'));
  const beforeQuit = waitForWalletBeforeQuit(pending, () => {
    quits += 1;
  });
  beforeQuit({ preventDefault() {} });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(quits, 1);
});
