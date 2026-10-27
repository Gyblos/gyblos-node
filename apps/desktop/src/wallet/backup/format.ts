// Validates untrusted portable bytes before KDF work; no filesystem or native stores.
import { WALLET } from '../constants';
import { BACKUP, BACKUP_ERROR } from './constants';
import { BackupError } from './error';

export function header(salt: Buffer, nonce: Buffer) {
  return {
    format: BACKUP.FORMAT,
    version: BACKUP.VERSION,
    kdf: BACKUP.KDF,
    cipher: BACKUP.CIPHER,
    keyFormat: BACKUP.KEY_FORMAT,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}
export function authenticatedHeader(value: ReturnType<typeof header>) {
  // A fixed-order array has no serialization-order ambiguity.
  return Buffer.from(
    JSON.stringify([
      value.format,
      value.version,
      value.kdf,
      value.cipher,
      value.keyFormat,
      value.salt,
      value.nonce,
    ]),
  );
}
function encoded(value: unknown, length: number | null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.toString('base64') !== value ||
    (length !== null
      ? bytes.length !== length
      : bytes.length > WALLET.MAX_SECRET_BYTES)
  )
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  return bytes;
}
export function parseBackup(file: Uint8Array) {
  if (
    !(file instanceof Uint8Array) ||
    file.byteLength === 0 ||
    file.byteLength > BACKUP.MAX_FILE_BYTES
  )
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(file).toString('utf8'));
  } catch {
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  }
  // Reject duplicate keys, invalid UTF-8 and alternate JSON spellings.
  if (!Buffer.from(JSON.stringify(value)).equals(Buffer.from(file)))
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== BACKUP.FIELDS ||
    !('format' in value) ||
    value.format !== BACKUP.FORMAT ||
    !('version' in value) ||
    value.version !== BACKUP.VERSION ||
    !('kdf' in value) ||
    value.kdf !== BACKUP.KDF ||
    !('cipher' in value) ||
    value.cipher !== BACKUP.CIPHER ||
    !('keyFormat' in value) ||
    value.keyFormat !== BACKUP.KEY_FORMAT ||
    !('salt' in value) ||
    !('nonce' in value) ||
    !('ciphertext' in value) ||
    !('tag' in value)
  )
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  const salt = encoded(value.salt, BACKUP.SALT_BYTES);
  const nonce = encoded(value.nonce, BACKUP.NONCE_BYTES);
  return {
    salt,
    nonce,
    aad: authenticatedHeader(header(salt, nonce)),
    ciphertext: encoded(value.ciphertext, null),
    tag: encoded(value.tag, BACKUP.TAG_BYTES),
  };
}
