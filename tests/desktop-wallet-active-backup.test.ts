// Exercises the existing portable backup flow against explicitly selected identities.
// Only disposable keys and injected encrypted storage are used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BACKUP_ACTION,
  BACKUP_RESULT,
  createWalletService,
} from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import { createWalletLibrary } from '@gyblos/desktop/wallet-library';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture';

void test('a backup targets the selected wallet and verification does not transfer to the original', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-active-backup-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'wallet');
  const protection = disposableProtection();
  const original = await createWalletService(root, protection).summary();
  const identity = disposableIdentity();
  const codec = createBackupCodec();
  const library = createWalletLibrary(root, protection);
  await library.restore(
    await codec.seal(identity.secret, TEST_BACKUP_PASSWORD),
    TEST_BACKUP_PASSWORD,
  );
  await library.select(identity.address);
  const path = join(home, 'export.json');
  let approvals = 0;
  const dialogs = {
    approve: async () => {
      approvals++;
      return true;
    },
    save: async () => path,
    select: async () => path,
  };
  const signal = new AbortController().signal;
  const request = {
    action: BACKUP_ACTION.CREATE,
    password: TEST_BACKUP_PASSWORD,
  };
  await assert.rejects(
    library.backup(original.address!, request, dialogs, signal),
  );
  assert.equal(approvals, 0);
  assert.equal(
    await library.backup(identity.address, request, dialogs, signal),
    BACKUP_RESULT.SAVED,
  );
  assert.ok(
    await codec.open(
      await readFile(path),
      TEST_BACKUP_PASSWORD,
      identity.address,
    ),
  );
  assert.equal(
    await library.backup(
      identity.address,
      { ...request, action: BACKUP_ACTION.VERIFY },
      dialogs,
      signal,
    ),
    BACKUP_RESULT.VERIFIED,
  );
  const current = await library.summary();
  assert.equal(
    current.wallets.find((wallet) => wallet.address === identity.address)
      ?.backupVerified,
    true,
  );
  assert.equal(
    current.wallets.find((wallet) => wallet.address === original.address)
      ?.backupVerified,
    false,
  );
  assert.ok(current.wallets.every((wallet) => wallet.fundingEnabled === false));
});
