// Remembers a completed saved-file check for one identity, without enabling funding.
// Missing, inaccessible, stale or unauthentic metadata always means unverified.
import { BACKUP_ERROR } from './backup/constants.js';
import { BackupError } from './backup/error.js';
import { walletAddress } from './key.js';
import type { WalletProtection } from './protection.js';
import {
  authenticVerification,
  sealVerification,
} from './verification-codec.js';
import { readVerification, writeVerification } from './verification-files.js';

export type ConsumeWalletSecret = <T>(
  consume: (secret: string, address: string) => Promise<T>,
) => Promise<T>;
export function createBackupVerification(
  root: string,
  protection: WalletProtection | null,
  consume: ConsumeWalletSecret,
) {
  return {
    async verified() {
      let ciphertext: Buffer | undefined;
      try {
        if (!protection) return false;
        ciphertext = await readVerification(root);
        const bytes = ciphertext;
        return await consume(async (secret, address) =>
          authenticVerification(
            await protection.decrypt(bytes),
            secret,
            address,
          ),
        );
      } catch {
        // This optional indicator fails closed without changing the wallet or leaking details.
        return false;
      } finally {
        ciphertext?.fill(0);
      }
    },
    async remember(recoveredSecret: string, signal: AbortSignal) {
      await consume(async (secret, address) => {
        if (
          !protection ||
          signal.aborted ||
          walletAddress(recoveredSecret) !== address
        )
          throw new BackupError(BACKUP_ERROR.IDENTITY);
        // Authenticate metadata with the installed key encoding, not the backup encoding.
        const ciphertext = await sealVerification(secret, address, protection);
        try {
          if (signal.aborted) throw new BackupError(BACKUP_ERROR.CANCELLED);
          await writeVerification(root, ciphertext, signal);
        } finally {
          ciphertext.fill(0);
        }
      });
    },
  };
}
