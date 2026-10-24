// Rejects public compatibility keys and noncanonical pinned Chromium CBC records.
// This is a downgrade guard, not general authentication of deterministic CBC.
import { createCipheriv, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

import { STORAGE_CBC } from './constants.js';
import type { WalletProtection } from './protection.js';

function sameBytes(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function checkPrefix(bytes: Buffer, prefix: string) {
  if (!bytes.subarray(0, STORAGE_CBC.PREFIX_BYTES).equals(Buffer.from(prefix)))
    throw new Error('Unsupported protected wallet ciphertext.');
}

function rejectPublicKey(bytes: Buffer, prefix: string, text: string) {
  for (const password of STORAGE_CBC.LEGACY_PASSWORDS) {
    const key = pbkdf2Sync(
      password,
      STORAGE_CBC.LEGACY_SALT,
      STORAGE_CBC.LEGACY_ITERATIONS,
      STORAGE_CBC.KEY_BYTES,
      STORAGE_CBC.LEGACY_DIGEST,
    );
    const cipher = createCipheriv(
      STORAGE_CBC.ALGORITHM,
      key,
      Buffer.alloc(STORAGE_CBC.IV_BYTES, STORAGE_CBC.IV_BYTE),
    );
    const weak = Buffer.concat([
      Buffer.from(prefix),
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    if (sameBytes(bytes, weak))
      throw new Error('Weak protected wallet ciphertext.');
  }
}

export function restrictCbcProtection(
  native: WalletProtection,
  prefix: string,
): WalletProtection {
  const encrypt = async (text: string) => {
    const bytes = await native.encrypt(text);
    checkPrefix(bytes, prefix);
    rejectPublicKey(bytes, prefix, text);
    return bytes;
  };
  return {
    provider: native.provider,
    available: () => native.available(),
    encrypt,
    decrypt: async (bytes) => {
      checkPrefix(bytes, prefix);
      const text = await native.decrypt(bytes);
      rejectPublicKey(bytes, prefix, text);
      // The old decryptor accepts legacy fallback keys. Only its current
      // deterministic encryptor can establish that this is a current-key record.
      if (!sameBytes(bytes, await encrypt(text)))
        throw new Error('Protected wallet key requires recovery.');
      return text;
    },
  };
}
