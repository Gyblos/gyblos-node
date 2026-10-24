// Reproduces Electron CBC compatibility with disposable bytes, never native keychains.
// Known legacy passwords are public upstream fixtures, not user credentials.
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createWalletService,
  WALLET,
  WALLET_STATUS,
  walletProtection,
  type SafeStoragePort,
} from '@gyblos/desktop/wallet';

function cbc(key: Buffer, prefix: string, text: string) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
}
function legacyKey(password: string) {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
}
function port(prefix: string): SafeStoragePort {
  const key = randomBytes(16);
  const encrypt = (text: string) => cbc(key, prefix, text);
  const decrypt = (bytes: Buffer) => {
    const version = bytes.subarray(0, 3).toString();
    const candidates =
      version === 'v10' && prefix === 'v11'
        ? [legacyKey('peanuts')]
        : [key, legacyKey('')];
    for (const candidate of candidates) {
      try {
        const decipher = createDecipheriv(
          'aes-128-cbc',
          candidate,
          Buffer.alloc(16, 32),
        );
        return Buffer.concat([
          decipher.update(bytes.subarray(3)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        /* Reproduce upstream compatibility retry with the next public key. */
      }
    }
    throw new Error('Synthetic decrypt failed.');
  };
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    isAsyncEncryptionAvailable: async () => true,
    encryptString: encrypt,
    decryptString: decrypt,
    encryptStringAsync: async (text) => encrypt(text),
    decryptStringAsync: async (bytes) => ({
      result: decrypt(bytes),
      shouldReEncrypt: false,
    }),
  };
}

void test('desktop Linux rejects public peanuts v10 ciphertext despite a secure current backend', async () => {
  const adapter = walletProtection('linux', port('v11'))!;
  await assert.rejects(
    adapter.decrypt(cbc(legacyKey('peanuts'), 'v10', 'synthetic')),
  );
});
void test('desktop Linux rejects the empty-key v11 fallback rather than trusting its prefix', async () => {
  const adapter = walletProtection('linux', port('v11'))!;
  await assert.rejects(adapter.decrypt(cbc(legacyKey(''), 'v11', 'synthetic')));
});
void test('desktop Mac rejects the empty-key v10 fallback', async () => {
  const adapter = walletProtection('darwin', port('v10'))!;
  await assert.rejects(adapter.decrypt(cbc(legacyKey(''), 'v10', 'synthetic')));
});
void test('desktop refuses OS encryption output that uses a public compatibility key', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const prefix = platform === 'darwin' ? 'v10' : 'v11';
    const storage = port(prefix);
    const weak = (text: string) => cbc(legacyKey(''), prefix, text);
    storage.encryptString = weak;
    storage.encryptStringAsync = async (text) => weak(text);
    await assert.rejects(
      walletProtection(platform, storage)!.encrypt('synthetic'),
    );
  }
});
void test('desktop protected Mac and Linux records retain genuine round trips', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const adapter = walletProtection(
      platform,
      port(platform === 'darwin' ? 'v10' : 'v11'),
    )!;
    const bytes = await adapter.encrypt('synthetic');
    assert.equal(await adapter.decrypt(bytes), 'synthetic');
    await assert.rejects(
      adapter.decrypt(Buffer.concat([Buffer.from('v99'), bytes.subarray(3)])),
    );
  }
});
void test('desktop substituted weak wallet record fails closed without rewriting or enabling funds', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-cbc-regression-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = port('v10');
  const adapter = walletProtection('darwin', storage)!;
  const original = await createWalletService(root, adapter).summary();
  assert.equal(original.status, WALLET_STATUS.READY);
  const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
  const record: { ciphertext: string } = JSON.parse(
    await readFile(path, 'utf8'),
  );
  const secret = await storage.decryptStringAsync(
    Buffer.from(record.ciphertext, 'base64'),
  );
  record.ciphertext = cbc(legacyKey(''), 'v10', secret.result).toString(
    'base64',
  );
  const substituted = JSON.stringify(record);
  await writeFile(path, substituted);
  const result = await createWalletService(root, adapter).summary();
  assert.equal(result.status, WALLET_STATUS.RECOVERY_REQUIRED);
  assert.equal(result.address, null);
  assert.equal(result.fundingEnabled, false);
  assert.equal(result.backupVerified, false);
  assert.equal(await readFile(path, 'utf8'), substituted);
});

void test('desktop Windows retains native randomized encryption without CBC restrictions', async () => {
  const storage = port('v10');
  storage.encryptStringAsync = async () => randomBytes(64);
  storage.decryptStringAsync = async () => ({
    result: 'synthetic',
    shouldReEncrypt: false,
  });
  const adapter = walletProtection('win32', storage)!;
  const first = await adapter.encrypt('synthetic');
  const second = await adapter.encrypt('synthetic');
  assert.notDeepEqual(first, second);
  assert.equal(await adapter.decrypt(first), 'synthetic');
});

void test('desktop rejects a previous native-key record and noncanonical prefix bytes', async () => {
  const storage = port('v10');
  const original = await storage.encryptStringAsync('synthetic');
  const adapter = walletProtection('darwin', storage)!;
  const highBitPrefix = Buffer.from(original);
  highBitPrefix[0] = highBitPrefix[0]! | 0x80;
  await assert.rejects(adapter.decrypt(highBitPrefix));
  const rotatedKey = randomBytes(16);
  storage.encryptStringAsync = async (text) => cbc(rotatedKey, 'v10', text);
  await assert.rejects(adapter.decrypt(original));
});
