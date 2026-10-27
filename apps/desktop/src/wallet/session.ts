// Coordinates automatic preparation and mutually exclusive Settings operations.
// Native dialogs and all keys stay in the host; only public status crosses IPC.
import { readBackupFile } from './backup-files';
import type { BackupDialogs } from './backup-flow';
import { BACKUP_RESULT, type BackupResult } from './backup-flow-model';
import { WALLET_LIBRARY_ERROR, WALLET_STATUS } from './constants';
import { copyPublicWalletAddress } from './copy-address';
import { createWalletLibrary, WalletLibraryError } from './library';
import {
  failedWalletCollection,
  prepareDesktopWallet,
  readWalletCollection,
} from './prepare';
import type { WalletProtection } from './protection';
import {
  parseActiveBackupRequest,
  parseWalletSettingsRequest,
  unavailableCollection,
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
  type WalletCollection,
  type WalletSettingsRequest,
  type WalletSettingsResult,
} from './settings-model';

async function restoreFromDialog(
  library: ReturnType<typeof createWalletLibrary>,
  dialogs: BackupDialogs,
  request: Extract<
    WalletSettingsRequest,
    { action: typeof WALLET_SETTINGS_ACTION.RESTORE }
  >,
  signal: AbortSignal,
): Promise<WalletSettingsResult> {
  const path = await dialogs.select();
  if (!path || signal.aborted) return WALLET_SETTINGS_RESULT.CANCELLED;
  const bytes = await readBackupFile(path);
  try {
    if (signal.aborted) return WALLET_SETTINGS_RESULT.CANCELLED;
    await library.restore(bytes, request.password, signal);
    return WALLET_SETTINGS_RESULT.RESTORED;
  } finally {
    bytes.fill(0);
  }
}
function operationFailure(
  error: unknown,
  signal: AbortSignal,
): WalletSettingsResult {
  if (signal.aborted) return WALLET_SETTINGS_RESULT.CANCELLED;
  if (error instanceof WalletLibraryError) {
    if (error.code === WALLET_LIBRARY_ERROR.EXISTS)
      return WALLET_SETTINGS_RESULT.EXISTS;
    if (error.code === WALLET_LIBRARY_ERROR.BUSY)
      return WALLET_SETTINGS_RESULT.BUSY;
  }
  return WALLET_SETTINGS_RESULT.FAILED;
}
class DesktopWalletSession {
  private readonly library;
  private pending: Promise<unknown> | undefined;
  private reading: Promise<WalletCollection> | undefined;
  private current = unavailableCollection(WALLET_STATUS.LOADING);
  readonly ready: Promise<WalletCollection>;
  constructor(
    private readonly root: string,
    private readonly protection: WalletProtection | null,
    private readonly dialogs: BackupDialogs,
    private readonly signal: AbortSignal,
  ) {
    this.library = createWalletLibrary(root, protection);
    this.ready = prepareDesktopWallet(root, protection, signal).then(
      (value) => {
        this.current = value;
        return value;
      },
    );
  }
  private async reload() {
    if (this.signal.aborted) return unavailableCollection();
    try {
      this.current = await readWalletCollection(this.root, this.protection);
    } catch (error) {
      this.current = failedWalletCollection(error);
    }
    return this.current;
  }
  private exclusive<T>(busy: T, cancelled: T, execute: () => Promise<T>) {
    if (this.signal.aborted) return Promise.resolve(cancelled);
    if (this.pending) return Promise.resolve(busy);
    const operation = Promise.resolve()
      .then(async () => {
        await this.reading;
        return execute();
      })
      .finally(() => {
        this.pending = undefined;
      });
    this.pending = operation;
    return operation;
  }
  private async manage(value: unknown): Promise<WalletSettingsResult> {
    const request = parseWalletSettingsRequest(value);
    if (!request) return WALLET_SETTINGS_RESULT.FAILED;
    const prepared = await this.ready;
    if (this.signal.aborted) return WALLET_SETTINGS_RESULT.CANCELLED;
    if (prepared.wallet.status !== WALLET_STATUS.READY)
      return WALLET_SETTINGS_RESULT.UNAVAILABLE;
    try {
      let result: WalletSettingsResult;
      if (request.action === WALLET_SETTINGS_ACTION.SELECT) {
        await this.library.select(request.address, this.signal);
        result = WALLET_SETTINGS_RESULT.SELECTED;
      } else
        result = await restoreFromDialog(
          this.library,
          this.dialogs,
          request,
          this.signal,
        );
      await this.reload();
      return result;
    } catch (error) {
      const result = operationFailure(error, this.signal);
      await this.reload();
      return result;
    }
  }
  private async executeBackup(value: unknown): Promise<BackupResult> {
    const request = parseActiveBackupRequest(value);
    if (!request) return BACKUP_RESULT.FAILED;
    await this.ready;
    if (this.signal.aborted) return BACKUP_RESULT.CANCELLED;
    try {
      return await this.library.backup(
        request.address,
        { action: request.action, password: request.password },
        this.dialogs,
        this.signal,
      );
    } catch {
      return this.signal.aborted
        ? BACKUP_RESULT.CANCELLED
        : BACKUP_RESULT.FAILED;
    } finally {
      await this.reload();
    }
  }
  async collection(): Promise<WalletCollection> {
    const prepared = await this.ready;
    if (this.pending) {
      await this.pending;
      return this.collection();
    }
    if (prepared.wallet.status !== WALLET_STATUS.READY)
      return this.signal.aborted ? unavailableCollection() : this.current;
    // Reserve the read synchronously; writers wait for it and later readers share it.
    this.reading ??= this.reload().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  async summary() {
    return (await this.collection()).wallet;
  }
  run(value: unknown) {
    return this.exclusive(
      WALLET_SETTINGS_RESULT.BUSY,
      WALLET_SETTINGS_RESULT.CANCELLED,
      () => this.manage(value),
    );
  }
  backup(value: unknown) {
    return this.exclusive(BACKUP_RESULT.BUSY, BACKUP_RESULT.CANCELLED, () =>
      this.executeBackup(value),
    );
  }
  copy(args: readonly unknown[], writeText: (text: string) => void) {
    return this.exclusive(false, false, async () => {
      await this.ready;
      return copyPublicWalletAddress(
        (await this.reload()).wallet,
        args,
        writeText,
      );
    });
  }
  async settled() {
    await this.ready;
    await this.pending;
    await this.reading;
  }
}
export function createDesktopWalletSession(
  root: string,
  protection: WalletProtection | null,
  dialogs: BackupDialogs,
  signal: AbortSignal,
) {
  return new DesktopWalletSession(root, protection, dialogs, signal);
}
