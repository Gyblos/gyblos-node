// Coordinates explicitly approved local backup operations in the host process.
// Returns status only: no paths, private keys, ciphertext or decrypted data cross IPC.
import { readBackupFile, writeBackupFile } from './backup-files';
import {
  BACKUP_ACTION,
  BACKUP_RESULT,
  parseBackupRequest,
  type BackupResult,
} from './backup-flow-model';
import { createBackupCodec } from './backup/index';
import type { createWalletService } from './service';

export interface BackupDialogs {
  approve(): Promise<boolean>;
  save(): Promise<string | null>;
  select(): Promise<string | null>;
}
export function createBackupFlow(
  wallet: ReturnType<typeof createWalletService>,
  dialogs: BackupDialogs,
  signal: AbortSignal,
) {
  const codec = createBackupCodec();
  let pending: Promise<BackupResult> | undefined;
  async function execute(value: unknown): Promise<BackupResult> {
    const request = parseBackupRequest(value);
    if (!request) return BACKUP_RESULT.FAILED;
    const stopped = () => signal.aborted;
    try {
      if (stopped() || !(await dialogs.approve()) || stopped())
        return BACKUP_RESULT.CANCELLED;
      const path =
        request.action === BACKUP_ACTION.CREATE
          ? await dialogs.save()
          : await dialogs.select();
      if (!path || stopped()) return BACKUP_RESULT.CANCELLED;
      if (request.action === BACKUP_ACTION.CREATE) {
        const encrypted = await wallet.withSecret((secret) =>
          codec.seal(secret, request.password, signal),
        );
        try {
          if (stopped()) return BACKUP_RESULT.CANCELLED;
          await writeBackupFile(path, encrypted);
        } finally {
          encrypted.fill(0);
        }
        return stopped() ? BACKUP_RESULT.CANCELLED : BACKUP_RESULT.SAVED;
      }
      const summary = await wallet.summary();
      if (!summary.address) return BACKUP_RESULT.FAILED;
      const bytes = await readBackupFile(path);
      try {
        const secret = await codec.open(
          bytes,
          request.password,
          summary.address,
          signal,
        );
        if (stopped()) return BACKUP_RESULT.CANCELLED;
        await wallet.rememberBackup(secret, signal);
      } finally {
        bytes.fill(0);
      }
      return BACKUP_RESULT.VERIFIED;
    } catch {
      return stopped() ? BACKUP_RESULT.CANCELLED : BACKUP_RESULT.FAILED;
    }
  }
  return {
    run(value: unknown): Promise<BackupResult> {
      if (pending) return Promise.resolve(BACKUP_RESULT.BUSY);
      pending = execute(value).finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async settled() {
      await pending;
    },
  };
}
