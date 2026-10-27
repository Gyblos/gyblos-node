// Synthetic filesystem/protection hooks reproduce exact pre-publication boundaries.
// No native stores, existing keys or funded wallets are accessed.
import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DESKTOP_WALLET_LIBRARY } from '@gyblos/config/home';
import { createWalletService } from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import {
  createWalletLibrary,
  WALLET_LIBRARY_ERROR,
} from '@gyblos/desktop/wallet-library';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture';

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const home = await filesystem.mkdtemp(
    join(tmpdir(), 'gyblos-library-interrupt-'),
  );
  context.after(() => filesystem.rm(home, { recursive: true, force: true }));
  const root = join(home, 'wallet');
  const protection = disposableProtection();
  const original = await createWalletService(root, protection).summary();
  const imported = disposableIdentity();
  const backup = await createBackupCodec().seal(
    imported.secret,
    TEST_BACKUP_PASSWORD,
  );
  return {
    root,
    protection,
    original,
    imported,
    backup,
    library: createWalletLibrary(root, protection),
  };
}

void test('abort after pending metadata fsync and before rename preserves the active wallet', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  const controller = new AbortController();
  const originalOpen = filesystem.open;
  filesystem.open = async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (String(args[0]).endsWith(DESKTOP_WALLET_LIBRARY.PENDING)) {
      const synchronize = file.sync.bind(file);
      file.sync = async () => {
        await synchronize();
        controller.abort();
      };
    }
    return file;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.library.select(f.imported.address, controller.signal),
      { code: WALLET_LIBRARY_ERROR.CANCELLED },
    );
  } finally {
    filesystem.open = originalOpen;
    syncBuiltinESMExports();
  }
  const current = await createWalletLibrary(f.root, f.protection).summary();
  assert.equal(current.activeAddress, f.original.address);
  assert.equal(current.wallets.length, 2);
});

void test('caller mutation between backup authentication and publication cannot swap recovered identity', async (context) => {
  const f = await fixture(context);
  const other = disposableIdentity();
  const changed = await createBackupCodec().seal(
    other.secret,
    TEST_BACKUP_PASSWORD,
  );
  assert.equal(changed.byteLength, f.backup.byteLength);
  const encrypt = f.protection.encrypt;
  let mutated = false;
  f.protection.encrypt = async (text) => {
    if (text.includes('"mac":')) {
      f.backup.set(changed);
      mutated = true;
    }
    return encrypt(text);
  };
  const restored = await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  assert.equal(mutated, true);
  assert.equal(restored.address, f.imported.address);
  const current = await createWalletLibrary(f.root, f.protection).summary();
  assert.equal(current.activeAddress, f.original.address);
  assert.equal(current.wallets.length, 2);
  assert.ok(
    current.wallets.some((wallet) => wallet.address === f.imported.address),
  );
  assert.ok(
    current.wallets.every(
      (wallet) =>
        wallet.address !== other.address && wallet.fundingEnabled === false,
    ),
  );
});
