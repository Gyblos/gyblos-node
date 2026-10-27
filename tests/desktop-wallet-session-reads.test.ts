// Concurrent public reads must not race the private filesystem lock or active selection.
// This exercises the production coordinator with disposable injected storage only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WALLET_STATUS } from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import { createDesktopWalletSession } from '@gyblos/desktop/wallet-session';
import {
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
} from '@gyblos/desktop/wallet-settings-model';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture';

void test('concurrent public collection reads all retain the ready wallet instead of a transient unavailable state', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-read-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const session = createDesktopWalletSession(
    join(home, 'wallet'),
    disposableProtection(),
    {
      approve: async () => false,
      save: async () => null,
      select: async () => null,
    },
    new AbortController().signal,
  );
  const initial = await session.ready;
  const views = await Promise.all(
    Array.from({ length: 8 }, () => session.collection()),
  );
  assert.ok(
    views.every(
      (view) =>
        view.wallet.status === WALLET_STATUS.READY &&
        view.wallet.address === initial.wallet.address,
    ),
  );
});
void test('a Settings selection waits for overlapping public reads and every later view reflects the selected address', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-read-switch-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const identity = disposableIdentity();
  const path = join(home, 'backup.json');
  await writeFile(
    path,
    await createBackupCodec().seal(identity.secret, TEST_BACKUP_PASSWORD),
  );
  const session = createDesktopWalletSession(
    join(home, 'wallet'),
    disposableProtection(),
    {
      approve: async () => false,
      save: async () => null,
      select: async () => path,
    },
    new AbortController().signal,
  );
  await session.ready;
  await session.run({
    action: WALLET_SETTINGS_ACTION.RESTORE,
    password: TEST_BACKUP_PASSWORD,
  });
  const reads = Array.from({ length: 4 }, () => session.collection());
  assert.equal(
    await session.run({
      action: WALLET_SETTINGS_ACTION.SELECT,
      address: identity.address,
    }),
    WALLET_SETTINGS_RESULT.SELECTED,
  );
  await Promise.all(reads);
  const later = await Promise.all(
    Array.from({ length: 4 }, () => session.collection()),
  );
  assert.ok(later.every((view) => view.wallet.address === identity.address));
});

void test('quit also waits for an already-started public wallet read', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-read-quit-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const protection = disposableProtection();
  const controller = new AbortController();
  const session = createDesktopWalletSession(
    join(home, 'wallet'),
    protection,
    {
      approve: async () => false,
      save: async () => null,
      select: async () => null,
    },
    controller.signal,
  );
  await session.ready;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const decrypt = protection.decrypt;
  protection.decrypt = async (bytes) => {
    entered();
    await blocked;
    return decrypt(bytes);
  };
  const reading = session.collection();
  await reached;
  controller.abort();
  let settled = false;
  const stopping = session.settled().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false);
  } finally {
    release();
    await reading;
    await stopping;
  }
});
