// Restores disposable identities into new destinations, never real wallets or keystores.
// The production primitive remains internal to Node, with no renderer or funding API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createWalletService,
  WALLET,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import {
  BACKUP_ERROR,
  BackupError,
  createBackupCodec,
} from '@gyblos/desktop/wallet-backup';
import {
  createWalletRestorer,
  WALLET_RESTORE_ERROR,
  WalletRestoreError,
} from '@gyblos/desktop/wallet-restore';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture.js';

async function fixture(
  run: (value: {
    home: string;
    root: string;
    backup: Buffer;
    identity: ReturnType<typeof disposableIdentity>;
    protection: ReturnType<typeof disposableProtection>;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-restore-'));
  try {
    const identity = disposableIdentity();
    const backup = await createBackupCodec().seal(
      identity.secret,
      TEST_BACKUP_PASSWORD,
    );
    await run({
      home,
      root: join(home, 'destination'),
      backup,
      identity,
      protection: disposableProtection(),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
function restoreError(
  code: (typeof WALLET_RESTORE_ERROR)[keyof typeof WALLET_RESTORE_ERROR],
) {
  return (error: unknown) =>
    error instanceof WalletRestoreError && error.code === code;
}
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

void test('wallet restore derives the authenticated backup identity without weakening expected-address checks', async () => {
  await fixture(async ({ backup, identity }) => {
    const codec = createBackupCodec();
    assert.deepEqual(
      await codec.recover(backup, TEST_BACKUP_PASSWORD),
      identity,
    );
    await assert.rejects(
      codec.open(backup, TEST_BACKUP_PASSWORD, disposableIdentity().address),
      (error: unknown) =>
        error instanceof BackupError && error.code === BACKUP_ERROR.IDENTITY,
    );
    await assert.rejects(
      codec.open(Buffer.alloc(0), 'short', 'invalid'),
      (error: unknown) =>
        error instanceof BackupError &&
        error.code === BACKUP_ERROR.INVALID_INPUT,
    );
  });
});
void test('wallet restore persists the same original key and address across fresh service instances with funding blocked', async () => {
  await fixture(async ({ root, backup, identity, protection }) => {
    const restored = await createWalletRestorer(root, protection).restore(
      backup,
      TEST_BACKUP_PASSWORD,
    );
    assert.equal(restored.status, WALLET_STATUS.READY);
    assert.equal(restored.address, identity.address);
    assert.equal(restored.fundingEnabled, false);
    assert.equal(restored.backupVerified, false);
    const restarted = createWalletService(root, protection);
    assert.deepEqual(await restarted.summary(), restored);
    assert.equal(
      await restarted.withSecret(async (secret) => secret === identity.secret),
      true,
    );
    assert.deepEqual(
      await createWalletService(root, protection).summary(),
      restored,
    );
    const record = await readFile(
      join(root, WALLET.DIRECTORY, WALLET.RECORD),
      'utf8',
    );
    assert.equal(record.includes(identity.secret), false);
    assert.deepEqual(Object.keys(restored).sort(), [
      'address',
      'backupVerified',
      'fundingEnabled',
      'status',
    ]);
  });
});
void test('wallet restore rejects existing empty, partial, corrupt and file destinations without reading or changing them', async () => {
  await fixture(async ({ home, backup, protection }) => {
    for (const kind of ['empty', 'partial', 'corrupt', 'file']) {
      const root = join(home, kind);
      await mkdir(root, { mode: 0o700 });
      const directory = join(root, WALLET.DIRECTORY);
      const sentinel = 'synthetic existing wallet data';
      if (kind === 'file') await writeFile(directory, sentinel);
      else {
        await mkdir(directory, { mode: 0o700 });
        if (kind !== 'empty')
          await writeFile(
            join(
              directory,
              kind === 'partial' ? WALLET.STAGING : WALLET.RECORD,
            ),
            sentinel,
          );
      }
      let decryptions = 0;
      const unavailable = {
        ...protection,
        decrypt: async () => {
          decryptions++;
          throw new Error('Existing keys must not be read');
        },
      };
      await assert.rejects(
        createWalletRestorer(root, unavailable).restore(
          backup,
          TEST_BACKUP_PASSWORD,
        ),
        restoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS),
      );
      assert.equal(decryptions, 0);
      if (kind === 'file')
        assert.equal(await readFile(directory, 'utf8'), sentinel);
      else if (kind !== 'empty')
        assert.equal(
          await readFile(
            join(
              directory,
              kind === 'partial' ? WALLET.STAGING : WALLET.RECORD,
            ),
            'utf8',
          ),
          sentinel,
        );
      else assert.equal((await fs.promises.readdir(directory)).length, 0);
    }
  });
});
void test(
  'wallet restore refuses a dangling destination symlink without replacing it',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async ({ root, home, backup, protection }) => {
      await mkdir(root, { mode: 0o700 });
      const directory = join(root, WALLET.DIRECTORY);
      await symlink(join(home, 'missing-target'), directory);
      await assert.rejects(
        createWalletRestorer(root, protection).restore(
          backup,
          TEST_BACKUP_PASSWORD,
        ),
        restoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS),
      );
      assert.equal((await lstat(directory)).isSymbolicLink(), true);
    });
  },
);
void test('wallet restore rejects bad password, altered backup and unavailable protection before creating destination', async () => {
  await fixture(async ({ root, backup, protection }) => {
    const restorer = createWalletRestorer(root, protection);
    await assert.rejects(
      restorer.restore(backup, 'Incorrect synthetic password'),
    );
    await absent(root);
    await assert.rejects(
      restorer.restore(Buffer.from('{}'), TEST_BACKUP_PASSWORD),
    );
    await absent(root);
    await assert.rejects(
      createWalletRestorer(root, null).restore(backup, TEST_BACKUP_PASSWORD),
      restoreError(WALLET_RESTORE_ERROR.UNAVAILABLE),
    );
    await absent(root);
    await assert.rejects(
      createWalletRestorer(root, {
        ...protection,
        available: async () => false,
      }).restore(backup, TEST_BACKUP_PASSWORD),
      restoreError(WALLET_RESTORE_ERROR.UNAVAILABLE),
    );
    await absent(root);
  });
});
void test('wallet restore permits exactly one concurrent restorer without overwriting the winning record', async () => {
  await fixture(async ({ root, backup, protection, identity }) => {
    const results = await Promise.allSettled([
      createWalletRestorer(root, protection).restore(
        backup,
        TEST_BACKUP_PASSWORD,
      ),
      createWalletRestorer(root, protection).restore(
        backup,
        TEST_BACKUP_PASSWORD,
      ),
    ]);
    assert.equal(
      results.filter((item) => item.status === 'fulfilled').length,
      1,
    );
    const rejected = results.find((item) => item.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.equal(
      restoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS)(rejected.reason),
      true,
    );
    assert.equal(
      (await createWalletService(root, protection).summary()).address,
      identity.address,
    );
  });
});
void test('wallet restore loses safely to automatic creation while decrypting and preserves that wallet', async () => {
  await fixture(async ({ root, backup, protection, identity }) => {
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = {
      ...protection,
      encrypt: async (secret: string) => {
        const bytes = await protection.encrypt(secret);
        entered();
        await waiting;
        return bytes;
      },
    };
    const restoring = createWalletRestorer(root, paused).restore(
      backup,
      TEST_BACKUP_PASSWORD,
    );
    await started;
    const created = await createWalletService(root, protection).summary();
    const original = await readFile(
      join(root, WALLET.DIRECTORY, WALLET.RECORD),
    );
    assert.notEqual(created.address, identity.address);
    release();
    await assert.rejects(
      restoring,
      restoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS),
    );
    assert.deepEqual(
      await readFile(join(root, WALLET.DIRECTORY, WALLET.RECORD)),
      original,
    );
  });
});
void test('wallet restore cancels before claiming a destination and bounds operations per restorer', async () => {
  await fixture(async ({ root, backup, protection }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createWalletRestorer(root, protection).restore(
        backup,
        TEST_BACKUP_PASSWORD,
        controller.signal,
      ),
      restoreError(WALLET_RESTORE_ERROR.CANCELLED),
    );
    await absent(root);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new AbortController();
    const paused = {
      ...protection,
      encrypt: async (secret: string) => {
        const bytes = await protection.encrypt(secret);
        entered();
        await waiting;
        return bytes;
      },
    };
    const restorer = createWalletRestorer(root, paused);
    const pending = restorer.restore(
      backup,
      TEST_BACKUP_PASSWORD,
      running.signal,
    );
    await enteredPromise;
    await assert.rejects(
      restorer.restore(backup, TEST_BACKUP_PASSWORD),
      restoreError(WALLET_RESTORE_ERROR.BUSY),
    );
    running.abort();
    release();
    await assert.rejects(pending, restoreError(WALLET_RESTORE_ERROR.CANCELLED));
    await absent(root);
  });
});
void test('wallet restore retains interrupted encrypted staging and prevents automatic replacement', async () => {
  await fixture(async ({ root, backup, protection, identity }) => {
    const original = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (args[0] === join(root, WALLET.DIRECTORY, WALLET.STAGING))
        handle.sync = async () => {
          throw new Error('synthetic private disk failure');
        };
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createWalletRestorer(root, protection).restore(
          backup,
          TEST_BACKUP_PASSWORD,
        ),
        restoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED),
      );
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
    const pending = await readFile(
      join(root, WALLET.DIRECTORY, WALLET.STAGING),
      'utf8',
    );
    assert.equal(pending.includes(identity.secret), false);
    assert.equal(
      (await createWalletService(root, protection).summary()).status,
      WALLET_STATUS.RECOVERY_REQUIRED,
    );
    await assert.rejects(
      createWalletRestorer(root, protection).restore(
        backup,
        TEST_BACKUP_PASSWORD,
      ),
      restoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS),
    );
    assert.equal(
      await readFile(join(root, WALLET.DIRECTORY, WALLET.STAGING), 'utf8'),
      pending,
    );
  });
});
void test('wallet restore reports interrupted confirmation after cancellation during commit without generating another identity', async () => {
  await fixture(async ({ root, backup, protection, identity }) => {
    const original = fs.promises.open;
    const controller = new AbortController();
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (args[0] === join(root, WALLET.DIRECTORY, WALLET.STAGING)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          controller.abort();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createWalletRestorer(root, protection).restore(
          backup,
          TEST_BACKUP_PASSWORD,
          controller.signal,
        ),
        restoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED),
      );
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
    const restarted = await createWalletService(root, protection).summary();
    assert.equal(restarted.address, identity.address);
    assert.equal(restarted.fundingEnabled, false);
    assert.equal(restarted.backupVerified, false);
  });
});
