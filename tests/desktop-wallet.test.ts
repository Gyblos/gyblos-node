// Tests protected-wallet lifecycle with disposable keys and fake OS encryption.
// Never opens an existing wallet, Keychain, DPAPI, node home or network connection.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createWalletService,
  parseWalletSummary,
  WALLET,
  WALLET_PROVIDER,
  WALLET_STATUS,
  walletProtection,
  type SafeStoragePort,
  type WalletProtection,
} from '@gyblos/desktop/wallet';

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), 'gyblos-wallet-test-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const key = randomBytes(32);
  const protection: WalletProtection = {
    provider: WALLET_PROVIDER.MAC,
    available: async () => true,
    encrypt: async (text) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const payload = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), payload]);
    },
    decrypt: async (bytes) => {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
  return { parent, root: join(parent, 'profile'), protection };
}

void test('desktop wallet creates once, persists its address, and never enables funding', async (context) => {
  const { root, protection } = await fixture(context);
  const service = createWalletService(root, protection);
  const [first, repeated] = await Promise.all([
    service.summary(),
    service.summary(),
  ]);
  assert.equal(first.status, WALLET_STATUS.READY);
  assert.deepEqual(repeated, first);
  assert.match(first.address!, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
  const encrypted = await readFile(path, 'utf8');
  assert.deepEqual(
    await createWalletService(root, protection).summary(),
    first,
  );
  assert.equal(await readFile(path, 'utf8'), encrypted);
  assert.deepEqual(Object.keys(first).sort(), [
    'address',
    'backupVerified',
    'fundingEnabled',
    'status',
  ]);
  assert.equal(first.backupVerified, false);
  assert.equal(first.fundingEnabled, false);
  assert.equal(encrypted.includes(first.address!), false);
  assert.equal(encrypted.includes('PRIVATE KEY'), false);
});

void test('desktop wallet independent concurrent initializers never publish different addresses', async (context) => {
  const { root, protection } = await fixture(context);
  const results = await Promise.all([
    createWalletService(root, protection).summary(),
    createWalletService(root, protection).summary(),
  ]);
  const ready = results.filter(
    (result) => result.status === WALLET_STATUS.READY,
  );
  assert.ok(ready.length >= 1);
  assert.equal(new Set(ready.map((result) => result.address)).size, 1);
  assert.deepEqual(
    await createWalletService(root, protection).summary(),
    ready[0],
  );
});

void test('desktop wallet refuses missing, corrupt, empty, oversized or interrupted records without replacement', async (context) => {
  const { parent, protection } = await fixture(context);
  for (const [index, contents] of [
    undefined,
    '',
    '{}',
    '{',
    'x'.repeat(WALLET.MAX_RECORD_BYTES + 1),
  ].entries()) {
    const root = join(parent, String(index));
    await mkdir(root, { mode: WALLET.PRIVATE_DIRECTORY });
    const directory = join(root, WALLET.DIRECTORY);
    await mkdir(directory, { mode: WALLET.PRIVATE_DIRECTORY });
    const path = join(directory, WALLET.RECORD);
    if (contents !== undefined)
      await writeFile(path, contents, { mode: WALLET.PRIVATE_FILE });
    assert.equal(
      (await createWalletService(root, protection).summary()).status,
      WALLET_STATUS.RECOVERY_REQUIRED,
    );
    if (contents !== undefined)
      assert.equal(await readFile(path, 'utf8'), contents);
    else await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});

void test('desktop wallet unavailable encryption never creates a secret or falls back to plaintext', async (context) => {
  const { root, protection } = await fixture(context);
  let encrypts = 0;
  const unavailable = {
    ...protection,
    available: async () => false,
    encrypt: async () => {
      encrypts += 1;
      return Buffer.alloc(0);
    },
  };
  assert.equal(
    (await createWalletService(root, unavailable).summary()).status,
    WALLET_STATUS.UNAVAILABLE,
  );
  assert.equal(encrypts, 0);
  await assert.rejects(readFile(join(root, WALLET.DIRECTORY, WALLET.RECORD)), {
    code: 'ENOENT',
  });
});

void test('desktop wallet denied or changed OS key retains original bytes and never exposes raw errors', async (context) => {
  const { root, protection } = await fixture(context);
  const first = await createWalletService(root, protection).summary();
  const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
  const before = await readFile(path, 'utf8');
  const denied = {
    ...protection,
    decrypt: async () => {
      throw new Error('synthetic-private-error');
    },
  };
  const result = await createWalletService(root, denied).summary();
  assert.equal(result.status, WALLET_STATUS.RECOVERY_REQUIRED);
  assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(
    await createWalletService(root, protection).summary(),
    first,
  );
});

void test('desktop wallet encryption failure leaves an interrupted marker rather than regenerating', async (context) => {
  const { root, protection } = await fixture(context);
  const broken = {
    ...protection,
    encrypt: async () => {
      throw new Error('synthetic');
    },
  };
  assert.equal(
    (await createWalletService(root, broken).summary()).status,
    WALLET_STATUS.RECOVERY_REQUIRED,
  );
  assert.equal(
    (await createWalletService(root, protection).summary()).status,
    WALLET_STATUS.RECOVERY_REQUIRED,
  );
});

void test('desktop wallet rejects tampered ciphertext and mismatched provider without rewriting', async (context) => {
  const { root, protection } = await fixture(context);
  await createWalletService(root, protection).summary();
  const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
  const record: { ciphertext: string; provider: string } = JSON.parse(
    await readFile(path, 'utf8'),
  );
  for (const invalid of [
    { ...record, provider: WALLET_PROVIDER.WINDOWS },
    { ...record, ciphertext: 'AAAA' },
  ]) {
    const bytes = JSON.stringify(invalid);
    await writeFile(path, bytes);
    assert.equal(
      (await createWalletService(root, protection).summary()).status,
      WALLET_STATUS.RECOVERY_REQUIRED,
    );
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

void test('desktop wallet rejects symlinked storage and permissive POSIX files', async (context) => {
  if (process.platform === 'win32')
    return context.skip('POSIX permissions and symlink fixture');
  const { root, parent, protection } = await fixture(context);
  await createWalletService(root, protection).summary();
  const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
  await chmod(path, 0o644);
  assert.equal(
    (await createWalletService(root, protection).summary()).status,
    WALLET_STATUS.RECOVERY_REQUIRED,
  );
  await chmod(path, 0o600);
  const other = join(parent, 'linked');
  await symlink(root, other);
  assert.equal(
    (await createWalletService(other, protection).summary()).status,
    WALLET_STATUS.UNAVAILABLE,
  );
});

void test('desktop wallet bridge rejects secrets, malformed status and any funding or backup override', () => {
  for (const value of [
    null,
    {},
    { status: 'other' },
    {
      status: WALLET_STATUS.READY,
      address: 'x',
      backupVerified: false,
      fundingEnabled: false,
    },
    {
      status: WALLET_STATUS.UNAVAILABLE,
      address: null,
      backupVerified: true,
      fundingEnabled: false,
    },
    {
      status: WALLET_STATUS.UNAVAILABLE,
      address: null,
      backupVerified: false,
      fundingEnabled: true,
    },
    {
      status: WALLET_STATUS.UNAVAILABLE,
      address: null,
      backupVerified: false,
      fundingEnabled: false,
      secret: 'synthetic',
    },
  ])
    assert.deepEqual(parseWalletSummary(value), {
      status: WALLET_STATUS.UNAVAILABLE,
      address: null,
      backupVerified: false,
      fundingEnabled: false,
    });
});

function storageDouble(backend: string, enabled = true): SafeStoragePort {
  return {
    isEncryptionAvailable: () => enabled,
    getSelectedStorageBackend: () => backend,
    isAsyncEncryptionAvailable: async () => enabled,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
    encryptStringAsync: async (value) => Buffer.from(value),
    decryptStringAsync: async (value) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
  };
}

void test('desktop wallet Linux refuses basic_text, unknown and future unidentified providers', async () => {
  for (const backend of ['basic_text', 'unknown', 'future', '']) {
    const adapter = walletProtection('linux', storageDouble(backend))!;
    assert.equal(await adapter.available(), false);
    await assert.rejects(adapter.encrypt('synthetic'));
    await assert.rejects(adapter.decrypt(Buffer.alloc(0)));
  }
});

void test('desktop wallet selects platform-specific protected providers and handles locked stores', async () => {
  for (const backend of [
    'gnome_libsecret',
    'kwallet',
    'kwallet5',
    'kwallet6',
  ]) {
    const adapter = walletProtection('linux', storageDouble(backend))!;
    assert.equal(await adapter.available(), true);
    assert.equal(
      await adapter.decrypt(await adapter.encrypt('synthetic')),
      'synthetic',
    );
  }
  for (const platform of ['darwin', 'win32'] as const) {
    const adapter = walletProtection(platform, storageDouble('unknown'))!;
    assert.equal(
      adapter.provider,
      platform === 'darwin' ? WALLET_PROVIDER.MAC : WALLET_PROVIDER.WINDOWS,
    );
    assert.equal(await adapter.available(), true);
    assert.equal(
      await adapter.decrypt(await adapter.encrypt('synthetic')),
      'synthetic',
    );
    assert.equal(
      await walletProtection(
        platform,
        storageDouble('unknown', false),
      )!.available(),
      false,
    );
  }
  assert.equal(walletProtection('freebsd', storageDouble('unknown')), null);
});
