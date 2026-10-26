// Creates or reads one protected desktop wallet, returning public metadata only.
// Interrupted or inaccessible records are retained for recovery, never replaced.
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BACKUP_ERROR } from './backup/constants.js';
import { BackupError } from './backup/error.js';
import { WALLET, WALLET_STATUS } from './constants.js';
import {
  ensureWalletRoot,
  isMissing,
  readWalletRecord,
  syncWalletDirectory,
  writeNewWallet,
} from './files.js';
import { createWalletSecret, walletAddress } from './key.js';
import { walletSummary, type WalletSummary } from './model.js';
import type { WalletProtection } from './protection.js';
import { createBackupVerification } from './verification.js';

function encryptedBytes(record: unknown, protection: WalletProtection) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(',') !== 'ciphertext,format,provider' ||
    !('format' in record) ||
    record.format !== WALLET.FORMAT ||
    !('provider' in record) ||
    record.provider !== protection.provider ||
    !('ciphertext' in record) ||
    typeof record.ciphertext !== 'string' ||
    record.ciphertext.length === 0 ||
    record.ciphertext.length > WALLET.MAX_RECORD_BYTES
  )
    throw new Error('Invalid protected wallet record.');
  const bytes = Buffer.from(record.ciphertext, 'base64');
  if (bytes.toString('base64') !== record.ciphertext)
    throw new Error('Invalid wallet encoding.');
  return bytes;
}

async function load(directory: string, protection: WalletProtection) {
  const record = await readWalletRecord(directory);
  const secret = await protection.decrypt(encryptedBytes(record, protection));
  return walletSummary(WALLET_STATUS.READY, walletAddress(secret));
}

// Read-only reload for restoration: absence must never initialize another identity.
export async function readExistingWallet(
  root: string,
  protection: WalletProtection,
) {
  return load(join(root, WALLET.DIRECTORY), protection);
}

async function initialize(
  root: string,
  protection: WalletProtection | null,
): Promise<WalletSummary> {
  if (!protection) return walletSummary(WALLET_STATUS.UNAVAILABLE);
  const directory = join(root, WALLET.DIRECTORY);
  let existing = false;
  try {
    await ensureWalletRoot(root);
    try {
      await lstat(directory);
      existing = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!(await protection.available()))
      return walletSummary(WALLET_STATUS.UNAVAILABLE);
    if (existing) return await load(directory, protection);
    // This marker prevents replacement after an interrupted initialization.
    await mkdir(directory, { mode: WALLET.PRIVATE_DIRECTORY });
    existing = true;
    await syncWalletDirectory(root);
    const secret = createWalletSecret();
    const address = walletAddress(secret);
    const ciphertext = await protection.encrypt(secret);
    if ((await protection.decrypt(ciphertext)) !== secret)
      throw new Error('Wallet encryption verification failed.');
    await writeNewWallet(
      directory,
      JSON.stringify({
        format: WALLET.FORMAT,
        provider: protection.provider,
        ciphertext: ciphertext.toString('base64'),
      }),
    );
    const persisted = await load(directory, protection);
    if (persisted.address !== address)
      throw new Error('Wallet identity mismatch.');
    return persisted;
  } catch {
    return walletSummary(
      existing ? WALLET_STATUS.RECOVERY_REQUIRED : WALLET_STATUS.UNAVAILABLE,
    );
  }
}

export function createWalletService(
  root: string,
  protection: WalletProtection | null,
  prepared?: Promise<WalletSummary>,
) {
  // A supplied startup identity disables all lazy initialization for secret reads.
  let pending: Promise<WalletSummary> | undefined = prepared;
  const identity = () => (pending ??= initialize(root, protection));
  async function withSecret<T>(
    consume: (secret: string, address: string) => Promise<T>,
  ) {
    const current = await identity();
    if (
      !protection ||
      current.status !== WALLET_STATUS.READY ||
      !current.address ||
      !(await protection.available())
    )
      throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
    const record = await readWalletRecord(join(root, WALLET.DIRECTORY));
    const secret = await protection.decrypt(encryptedBytes(record, protection));
    if (walletAddress(secret) !== current.address)
      throw new BackupError(BACKUP_ERROR.IDENTITY);
    return consume(secret, current.address);
  }
  const verification = createBackupVerification(root, protection, withSecret);
  return {
    async summary() {
      const current = await identity();
      return {
        ...current,
        backupVerified:
          current.status === WALLET_STATUS.READY &&
          (await verification.verified()),
      };
    },
    withSecret,
    rememberBackup: verification.remember,
  };
}
