// Authenticates local backup metadata with the current wallet key, then OS-protects it.
// This is not a payment signature, a portable backup or proof that the file still exists.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { BACKUP } from './backup/constants.js';
import { BACKUP_VERIFICATION } from './constants.js';
import type { WalletProtection } from './protection.js';

function tag(secret: string, address: string) {
  const key = Buffer.from(secret, 'base64');
  try {
    return createHmac(BACKUP_VERIFICATION.MAC_ALGORITHM, key)
      .update(BACKUP_VERIFICATION.DOMAIN)
      .update(
        JSON.stringify([
          BACKUP_VERIFICATION.VERSION,
          BACKUP.FORMAT,
          BACKUP.VERSION,
          address,
        ]),
      )
      .digest();
  } finally {
    key.fill(0);
  }
}
export async function sealVerification(
  secret: string,
  address: string,
  protection: WalletProtection,
) {
  const mac = tag(secret, address);
  try {
    const plaintext = JSON.stringify({
      version: BACKUP_VERIFICATION.VERSION,
      backupFormat: BACKUP.FORMAT,
      backupVersion: BACKUP.VERSION,
      address,
      mac: mac.toString('base64'),
    });
    const ciphertext = await protection.encrypt(plaintext);
    if ((await protection.decrypt(ciphertext)) !== plaintext)
      throw new Error('Backup metadata protection failed.');
    return ciphertext;
  } finally {
    mac.fill(0);
  }
}
export function authenticVerification(
  plaintext: string,
  secret: string,
  address: string,
) {
  if (Buffer.byteLength(plaintext) > BACKUP_VERIFICATION.MAX_PLAINTEXT_BYTES)
    return false;
  const value: unknown = JSON.parse(plaintext);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'address,backupFormat,backupVersion,mac,version' ||
    !('version' in value) ||
    value.version !== BACKUP_VERIFICATION.VERSION ||
    !('backupFormat' in value) ||
    value.backupFormat !== BACKUP.FORMAT ||
    !('backupVersion' in value) ||
    value.backupVersion !== BACKUP.VERSION ||
    !('address' in value) ||
    value.address !== address ||
    !('mac' in value) ||
    typeof value.mac !== 'string'
  )
    return false;
  const expected = tag(secret, address);
  const actual = Buffer.from(value.mac, 'base64');
  try {
    return (
      actual.toString('base64') === value.mac &&
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}
