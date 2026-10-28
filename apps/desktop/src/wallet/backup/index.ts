// Internal Node-only password codec; no live wallet, Electron, filesystem or IPC.
// Publishes material only after authentication/key validation; open also checks identity.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';

import { walletAddress } from '../key';
import { BACKUP, BACKUP_ERROR } from './constants';
import { BackupError } from './error';
import { authenticatedHeader, header, parseBackup } from './format';

export { BACKUP, BACKUP_ERROR } from './constants';
export { BackupError } from './error';

function passwordBytes(password: string) {
  if (typeof password !== 'string')
    throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
  const length = Buffer.byteLength(password, 'utf8');
  if (length < BACKUP.MIN_PASSWORD_BYTES || length > BACKUP.MAX_PASSWORD_BYTES)
    throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
  const bytes = Buffer.from(password, 'utf8');
  if (bytes.toString('utf8') !== password) {
    bytes.fill(0);
    throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
  }
  return bytes;
}
function addressOf(secret: string) {
  try {
    return walletAddress(secret);
  } catch {
    throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
  }
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new BackupError(BACKUP_ERROR.CANCELLED);
}
async function derive(password: string, salt: Buffer) {
  const bytes = passwordBytes(password);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        bytes,
        salt,
        BACKUP.KEY_BYTES,
        {
          N: BACKUP.COST,
          r: BACKUP.BLOCK_SIZE,
          p: BACKUP.PARALLELISM,
          maxmem: BACKUP.MAX_MEMORY,
        },
        (error, key) =>
          error
            ? reject(new BackupError(BACKUP_ERROR.INVALID_INPUT))
            : resolve(key),
      );
    });
  } finally {
    bytes.fill(0);
  }
}
async function seal(secret: string, password: string) {
  addressOf(secret);
  const salt = randomBytes(BACKUP.SALT_BYTES);
  const nonce = randomBytes(BACKUP.NONCE_BYTES);
  const metadata = header(salt, nonce);
  const key = await derive(password, salt);
  const plain = Buffer.from(secret, 'base64');
  try {
    const cipher = createCipheriv(BACKUP.CIPHER, key, nonce, {
      authTagLength: BACKUP.TAG_BYTES,
    });
    cipher.setAAD(authenticatedHeader(metadata));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.from(
      JSON.stringify({
        ...metadata,
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      }),
    );
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}
async function recover(file: Uint8Array, password: string) {
  const record = parseBackup(file);
  const key = await derive(password, record.salt);
  let chunk = Buffer.alloc(0);
  let plain = Buffer.alloc(0);
  try {
    const decipher = createDecipheriv(BACKUP.CIPHER, key, record.nonce, {
      authTagLength: BACKUP.TAG_BYTES,
    });
    decipher.setAAD(record.aad);
    decipher.setAuthTag(record.tag);
    try {
      chunk = decipher.update(record.ciphertext);
      plain = Buffer.concat([chunk, decipher.final()]);
    } catch {
      throw new BackupError(BACKUP_ERROR.AUTHENTICATION);
    }
    const secret = plain.toString('base64');
    return { secret, address: addressOf(secret) };
  } finally {
    key.fill(0);
    chunk.fill(0);
    plain.fill(0);
  }
}
async function open(
  file: Uint8Array,
  password: string,
  expectedAddress: string,
) {
  if (
    typeof expectedAddress !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedAddress)
  )
    throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
  const recovered = await recover(file, password);
  if (recovered.address !== expectedAddress)
    throw new BackupError(BACKUP_ERROR.IDENTITY);
  return recovered.secret;
}
export function createBackupCodec() {
  let active = false;
  async function run<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    cancelled(signal);
    if (active) throw new BackupError(BACKUP_ERROR.BUSY);
    active = true;
    try {
      const result = await operation();
      cancelled(signal);
      return result;
    } finally {
      active = false;
    }
  }
  return {
    recover: (file: Uint8Array, password: string, signal?: AbortSignal) =>
      run(() => recover(file, password), signal),
    seal: (secret: string, password: string, signal?: AbortSignal) =>
      run(() => seal(secret, password), signal),
    open: (
      file: Uint8Array,
      password: string,
      address: string,
      signal?: AbortSignal,
    ) => run(() => open(file, password, address), signal),
  };
}
