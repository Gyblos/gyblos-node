// Disposable recovery harness only; no production restore or native keystore access.
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import { getBase58Decoder } from '@solana/kit';

import {
  createWalletService,
  WALLET,
  WALLET_PROVIDER,
  WALLET_STATUS,
  type WalletProtection,
} from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';

// Public synthetic credentials, never reuse for an actual wallet.
export const TEST_BACKUP_PASSWORD = 'Disposable cross-platform fixture 🔐';
export function disposableIdentity() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(pair.privateKey).export({ format: 'jwk' });
  assert.ok(publicKey.x);
  return {
    secret: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    address: getBase58Decoder().decode(Buffer.from(publicKey.x, 'base64url')),
  };
}
export function disposableProtection(): WalletProtection {
  const key = randomBytes(32);
  const provider =
    process.platform === 'win32'
      ? WALLET_PROVIDER.WINDOWS
      : process.platform === 'darwin'
        ? WALLET_PROVIDER.MAC
        : WALLET_PROVIDER.LINUX;
  return {
    provider,
    available: async () => true,
    encrypt: async (secret) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([
        nonce,
        cipher.update(secret, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decrypt: async (bytes) => {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
export async function restoreDisposable(
  root: string,
  backup: Uint8Array,
  address: string,
  protection: WalletProtection,
  signal?: AbortSignal,
) {
  const secret = await createBackupCodec().open(
    backup,
    TEST_BACKUP_PASSWORD,
    address,
    signal,
  );
  assert.equal(
    await protection.available(),
    true,
    'Synthetic store unavailable',
  );
  const bytes = await protection.encrypt(secret);
  if (signal?.aborted) throw new Error('Disposable restore cancelled');
  // mkdir is exclusive: even an interrupted prior marker must not be replaced.
  await mkdir(root, { mode: WALLET.PRIVATE_DIRECTORY });
  const directory = join(root, WALLET.DIRECTORY);
  await mkdir(directory, { mode: WALLET.PRIVATE_DIRECTORY });
  const file = await open(
    join(directory, WALLET.RECORD),
    'wx',
    WALLET.PRIVATE_FILE,
  );
  try {
    await file.writeFile(
      JSON.stringify({
        format: WALLET.FORMAT,
        provider: protection.provider,
        ciphertext: bytes.toString('base64'),
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  // A fresh service instance reads only the destination's protected record.
  const recovered = await createWalletService(root, protection).summary();
  assert.equal(recovered.status, WALLET_STATUS.READY);
  assert.equal(recovered.address, address);
  assert.equal(recovered.fundingEnabled, false);
  assert.equal(recovered.backupVerified, false);
  return recovered;
}
