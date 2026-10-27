// Disposable identities only: restoration preserves custody and explicit selection.
// Provider doubles exercise portable contracts, never native keystore acceptance.
import assert from 'node:assert/strict';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { desktopWalletLibraryPaths } from '@gyblos/config/home';
import {
  BACKUP_VERIFICATION,
  createWalletService,
  WALLET,
  WALLET_PROVIDER,
} from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import {
  createWalletLibrary,
  WALLET_LIBRARY_ERROR,
} from '@gyblos/desktop/wallet-library';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture.js';

async function fixture(
  context: { after(fn: () => Promise<void>): void },
  provider: (typeof WALLET_PROVIDER)[keyof typeof WALLET_PROVIDER] = WALLET_PROVIDER.MAC,
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-library-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'desktop');
  const protection = disposableProtection();
  protection.provider = provider;
  const original = createWalletService(root, protection);
  const initial = await original.summary();
  assert.ok(initial.address);
  const recovered = disposableIdentity();
  const backup = await createBackupCodec().seal(
    recovered.secret,
    TEST_BACKUP_PASSWORD,
  );
  return {
    home,
    root,
    protection,
    original,
    initial,
    recovered,
    backup,
    library: createWalletLibrary(root, protection),
  };
}

for (const provider of Object.values(WALLET_PROVIDER)) {
  void test(`wallet library preserves both identities, selection and address-bound backup with injected ${provider}`, async (context) => {
    const f = await fixture(context, provider);
    const originalPath = join(f.root, WALLET.DIRECTORY, WALLET.RECORD);
    const originalBytes = await readFile(originalPath);
    const before = await f.library.summary();
    assert.equal(before.activeAddress, f.initial.address);
    await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
    assert.deepEqual(await readFile(originalPath), originalBytes);
    let current = await f.library.summary();
    assert.equal(current.activeAddress, f.initial.address);
    assert.deepEqual(
      current.wallets.map((item) => item.address).sort(),
      [f.initial.address, f.recovered.address].sort(),
    );
    await f.library.verifyBackup(
      f.recovered.address,
      f.backup,
      TEST_BACKUP_PASSWORD,
    );
    await f.library.select(f.recovered.address);
    current = await createWalletLibrary(f.root, f.protection).summary();
    assert.equal(current.activeAddress, f.recovered.address);
    assert.equal(
      current.wallets.find((item) => item.address === f.recovered.address)
        ?.backupVerified,
      true,
    );
    assert.equal(
      current.wallets.find((item) => item.address === f.initial.address)
        ?.backupVerified,
      false,
    );
    assert.ok(current.wallets.every((item) => item.fundingEnabled === false));
    await f.library.select(f.initial.address!);
    assert.equal(
      (await createWalletLibrary(f.root, f.protection).summary()).activeAddress,
      f.initial.address,
    );
  });
}

void test('duplicate restored or original address never overwrites records or backup state', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  await f.library.verifyBackup(
    f.recovered.address,
    f.backup,
    TEST_BACKUP_PASSWORD,
  );
  const before = await f.library.summary();
  await assert.rejects(f.library.restore(f.backup, TEST_BACKUP_PASSWORD), {
    code: WALLET_LIBRARY_ERROR.EXISTS,
  });
  const originalBackup = await f.original.withSecret((secret) =>
    createBackupCodec().seal(secret, TEST_BACKUP_PASSWORD),
  );
  await assert.rejects(
    f.library.restore(originalBackup, TEST_BACKUP_PASSWORD),
    { code: WALLET_LIBRARY_ERROR.EXISTS },
  );
  assert.deepEqual(await f.library.summary(), before);
});

void test('wrong password, wrong address verification and cancellation preserve the original', async (context) => {
  const f = await fixture(context);
  await assert.rejects(f.library.restore(f.backup, 'wrong password'));
  await assert.rejects(
    f.library.verifyBackup(f.initial.address!, f.backup, TEST_BACKUP_PASSWORD),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.library.restore(f.backup, TEST_BACKUP_PASSWORD, controller.signal),
    { code: WALLET_LIBRARY_ERROR.CANCELLED },
  );
  assert.deepEqual((await f.library.summary()).wallets, [f.initial]);
});

void test('two library instances fail busy rather than racing import or selection', async (context) => {
  const f = await fixture(context);
  await f.library.summary();
  const paths = desktopWalletLibraryPaths(f.root);
  await mkdir(paths.lock, { mode: 0o700 });
  const other = createWalletLibrary(f.root, f.protection);
  await assert.rejects(other.select(f.initial.address!), {
    code: WALLET_LIBRARY_ERROR.BUSY,
  });
  await assert.rejects(other.restore(f.backup, TEST_BACKUP_PASSWORD), {
    code: WALLET_LIBRARY_ERROR.BUSY,
  });
  await rm(paths.lock, { recursive: true });
  assert.equal((await other.summary()).activeAddress, f.initial.address);
});

void test('missing, corrupt or foreign active metadata never silently selects a different wallet', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  await f.library.select(f.recovered.address);
  const paths = desktopWalletLibraryPaths(f.root);
  const selected = await readFile(paths.active);
  for (const bytes of [
    Buffer.from('corrupt'),
    await f.protection.encrypt('{"version":1,"address":"../escape"}'),
  ]) {
    await writeFile(paths.active, bytes, { mode: 0o600 });
    await assert.rejects(createWalletLibrary(f.root, f.protection).summary(), {
      code: WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED,
    });
  }
  await rm(paths.active);
  await assert.rejects(f.library.summary(), {
    code: WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED,
  });
  await writeFile(paths.active, selected, { mode: 0o600 });
  assert.equal((await f.library.summary()).activeAddress, f.recovered.address);
});

void test('copied verification metadata cannot mark another address verified', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  await f.library.verifyBackup(
    f.recovered.address,
    f.backup,
    TEST_BACKUP_PASSWORD,
  );
  const imported = desktopWalletLibraryPaths(
    f.root,
    f.recovered.address,
  ).identityRoot;
  await copyFile(
    join(imported, WALLET.DIRECTORY, BACKUP_VERIFICATION.RECORD),
    join(f.root, WALLET.DIRECTORY, BACKUP_VERIFICATION.RECORD),
  );
  const current = await f.library.summary();
  assert.equal(
    current.wallets.find((item) => item.address === f.initial.address)
      ?.backupVerified,
    false,
  );
  assert.equal(
    current.wallets.find((item) => item.address === f.recovered.address)
      ?.backupVerified,
    true,
  );
});

void test('interrupted claimed identity is retained and cannot be overwritten on retry', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  const interrupted = disposableIdentity();
  const interruptedBackup = await createBackupCodec().seal(
    interrupted.secret,
    TEST_BACKUP_PASSWORD,
  );
  const destination = desktopWalletLibraryPaths(
    f.root,
    interrupted.address,
  ).identityRoot;
  await mkdir(destination, { mode: 0o700 });
  await assert.rejects(
    f.library.restore(interruptedBackup, TEST_BACKUP_PASSWORD),
  );
  assert.equal((await lstat(destination)).isDirectory(), true);
  assert.equal((await f.original.summary()).address, f.initial.address);
  await assert.rejects(f.library.summary(), {
    code: WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED,
  });
});

void test('unavailable protection never initializes another identity or exposes private errors', async (context) => {
  const f = await fixture(context);
  const original = await readFile(
    join(f.root, WALLET.DIRECTORY, WALLET.RECORD),
  );
  f.protection.available = async () => false;
  await assert.rejects(f.library.restore(f.backup, TEST_BACKUP_PASSWORD), {
    code: WALLET_LIBRARY_ERROR.UNAVAILABLE,
  });
  assert.deepEqual(
    await readFile(join(f.root, WALLET.DIRECTORY, WALLET.RECORD)),
    original,
  );
  await assert.rejects(
    createWalletLibrary(join(f.home, 'absent'), f.protection).summary(),
  );
  await assert.rejects(lstat(join(f.home, 'absent')), { code: 'ENOENT' });
});

void test('cancellation during selection encryption preserves the previously selected address', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  const controller = new AbortController();
  const encrypt = f.protection.encrypt;
  f.protection.encrypt = async (text) => {
    controller.abort();
    return encrypt(text);
  };
  await assert.rejects(
    f.library.select(f.recovered.address, controller.signal),
    { code: WALLET_LIBRARY_ERROR.CANCELLED },
  );
  f.protection.encrypt = encrypt;
  assert.equal(
    (await createWalletLibrary(f.root, f.protection).summary()).activeAddress,
    f.initial.address,
  );
  assert.equal((await f.library.summary()).wallets.length, 2);
});

void test('a failed selection write retains custody and the last committed selection', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  const paths = desktopWalletLibraryPaths(f.root);
  await writeFile(paths.pending, 'interrupted encrypted metadata', {
    mode: 0o600,
  });
  await assert.rejects(f.library.select(f.recovered.address), {
    code: WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED,
  });
  const current = await createWalletLibrary(f.root, f.protection).summary();
  assert.equal(current.activeAddress, f.initial.address);
  assert.equal(current.wallets.length, 2);
  assert.equal(
    await readFile(paths.pending, 'utf8'),
    'interrupted encrypted metadata',
  );
});

void test('selection is authenticated, address-bounded and has no wallet secret or backup password on disk', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  const paths = desktopWalletLibraryPaths(f.root);
  const encrypted = await readFile(paths.active);
  for (const text of [
    f.initial.address!,
    f.recovered.secret,
    TEST_BACKUP_PASSWORD,
  ])
    assert.equal(encrypted.includes(Buffer.from(text)), false);
  const selection = await f.protection.decrypt(encrypted);
  const forged = selection.replace(
    /"mac":"[^"]+"/,
    '"mac":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="',
  );
  await writeFile(paths.active, await f.protection.encrypt(forged));
  await assert.rejects(f.library.summary(), {
    code: WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED,
  });
  assert.throws(() => desktopWalletLibraryPaths(f.root, '../escape'), {
    code: 'CONFIG_INVALID_WALLET_LIBRARY_ADDRESS',
  });
});

void test('same-address selection is a no-op and cannot alter a committed active record', async (context) => {
  const f = await fixture(context);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  const path = desktopWalletLibraryPaths(f.root).active;
  const before = await readFile(path);
  f.protection.encrypt = async () => {
    throw new Error('Must not encrypt');
  };
  await f.library.select(f.initial.address!);
  assert.deepEqual(await readFile(path), before);
});

void test('import retains an already verified original backup byte-for-byte', async (context) => {
  const f = await fixture(context);
  const originalBackup = await f.original.withSecret((secret) =>
    createBackupCodec().seal(secret, TEST_BACKUP_PASSWORD),
  );
  const originalSecret = await createBackupCodec().open(
    originalBackup,
    TEST_BACKUP_PASSWORD,
    f.initial.address!,
  );
  await f.original.rememberBackup(originalSecret, new AbortController().signal);
  const receipt = join(f.root, WALLET.DIRECTORY, BACKUP_VERIFICATION.RECORD);
  const before = await readFile(receipt);
  await f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  await f.library.select(f.recovered.address);
  const current = await createWalletLibrary(f.root, f.protection).summary();
  assert.equal(
    current.wallets.find((item) => item.address === f.initial.address)
      ?.backupVerified,
    true,
  );
  assert.equal(
    current.wallets.find((item) => item.address === f.recovered.address)
      ?.backupVerified,
    false,
  );
  assert.deepEqual(await readFile(receipt), before);
});

void test('simultaneous independent instances cannot change selection while restoration holds the lock', async (context) => {
  const f = await fixture(context);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const encrypt = f.protection.encrypt;
  f.protection.encrypt = async (text) => {
    if (text.includes('"mac":')) {
      entered!();
      await blocked;
    }
    return encrypt(text);
  };
  const importing = f.library.restore(f.backup, TEST_BACKUP_PASSWORD);
  await reached;
  try {
    await assert.rejects(
      createWalletLibrary(f.root, f.protection).select(f.initial.address!),
      { code: WALLET_LIBRARY_ERROR.BUSY },
    );
  } finally {
    release!();
  }
  await importing;
  const current = await createWalletLibrary(f.root, f.protection).summary();
  assert.equal(current.activeAddress, f.initial.address);
  assert.equal(current.wallets.length, 2);
});
