// Passive public reads use a snapshot; explicit selection publishes the updated identity.
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
    async () => true,
  );
  const initial = await session.activate();
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
void test('a Settings selection updates the cached address while concurrent public reads stay harmless', async (context) => {
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
    async () => true,
  );
  await session.activate();
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

void test('passive reads and quit do not decrypt an already activated wallet again', async (context) => {
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
    async () => true,
  );
  const initial = await session.activate();
  protection.available = async () =>
    assert.fail('passive read must not consult OS storage');
  protection.decrypt = async () => assert.fail('passive read must not decrypt');
  assert.deepEqual(await session.collection(), initial);
  controller.abort();
  await session.settled();
  assert.equal(
    (await session.collection()).wallet.status,
    WALLET_STATUS.UNAVAILABLE,
  );
});
