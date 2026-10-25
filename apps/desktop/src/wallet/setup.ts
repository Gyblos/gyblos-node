// Coordinates first-run choice before any automatic wallet generation.
// Existing wallets are never restore targets; all state returned is public-only.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { readBackupFile } from './backup-files.js';
import { WALLET, WALLET_RESTORE_ERROR } from './constants.js';
import { checkWalletRoot, isMissing } from './files.js';
import { WALLET_STATUS, walletSummary, type WalletSummary } from './model.js';
import type { WalletProtection } from './protection.js';
import { createWalletRestorer, WalletRestoreError } from './restore.js';
import { createWalletService, readExistingWallet } from './service.js';
import {
  parseSetupRequest,
  SETUP_ACTION,
  SETUP_ERROR,
  SETUP_STATUS,
  setupView,
  type SetupRequest,
  type SetupView,
} from './setup-model.js';

interface SetupDialogs {
  select(): Promise<string | null>;
}
class WalletSetup {
  readonly summary: Promise<WalletSummary>;
  private release: (summary: WalletSummary) => void = () => {};
  private view = setupView(SETUP_STATUS.CHOICE);
  private finished = false;
  private restored: WalletSummary | undefined;
  private pending: Promise<SetupView> | undefined;
  private readonly inspection: Promise<void>;
  private readonly wallet;
  private readonly restorer;

  constructor(
    private readonly root: string,
    private readonly protection: WalletProtection | null,
    private readonly dialogs: SetupDialogs,
    private readonly signal: AbortSignal,
  ) {
    this.wallet = createWalletService(root, protection);
    this.restorer = createWalletRestorer(root, protection);
    this.summary = new Promise((resolve) => {
      this.release = resolve;
    });
    this.inspection = signal.aborted ? Promise.resolve() : this.inspect();
    if (signal.aborted) this.stop();
    else signal.addEventListener('abort', this.stop, { once: true });
  }
  private stop = () => {
    this.finish(walletSummary(WALLET_STATUS.UNAVAILABLE));
  };
  private finish(summary: WalletSummary) {
    if (this.finished) return;
    this.finished = true;
    this.signal.removeEventListener('abort', this.stop);
    this.view = setupView(SETUP_STATUS.COMPLETE);
    this.release(summary);
  }
  private async inspect() {
    try {
      await lstat(join(this.root, WALLET.DIRECTORY));
    } catch (error) {
      if (!isMissing(error))
        this.finish(walletSummary(WALLET_STATUS.RECOVERY_REQUIRED));
      return;
    }
    if (this.signal.aborted) return;
    // Once an existing destination is observed, never call an initializer.
    try {
      await checkWalletRoot(this.root);
      if (this.signal.aborted) return;
      if (!this.protection) {
        this.finish(walletSummary(WALLET_STATUS.UNAVAILABLE));
        return;
      }
      const available = await this.protection.available();
      if (this.signal.aborted) return;
      if (!available) this.finish(walletSummary(WALLET_STATUS.UNAVAILABLE));
      else this.finish(await readExistingWallet(this.root, this.protection));
    } catch {
      this.finish(walletSummary(WALLET_STATUS.RECOVERY_REQUIRED));
    }
  }
  async state() {
    await this.inspection;
    return this.view;
  }
  async run(value: unknown): Promise<SetupView> {
    await this.inspection;
    const request = parseSetupRequest(value);
    if (!request)
      return setupView(this.view.status, SETUP_ERROR.FAILED, this.view.address);
    if (request.action === SETUP_ACTION.STATUS || this.finished)
      return this.view;
    if (this.pending)
      return setupView(this.view.status, SETUP_ERROR.BUSY, this.view.address);
    const continuing = request.action === SETUP_ACTION.CONTINUE;
    if (
      continuing
        ? this.view.status !== SETUP_STATUS.RESTORED &&
          this.view.status !== SETUP_STATUS.BLOCKED
        : this.view.status !== SETUP_STATUS.CHOICE
    )
      return this.view;
    this.pending = this.execute(request).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async execute(request: SetupRequest): Promise<SetupView> {
    if (this.signal.aborted) return this.view;
    if (request.action === SETUP_ACTION.CREATE) {
      this.finish(await this.wallet.summary());
      return this.view;
    }
    if (request.action === SETUP_ACTION.CONTINUE) {
      this.finish(
        this.restored ?? walletSummary(WALLET_STATUS.RECOVERY_REQUIRED),
      );
      return this.view;
    }
    if (request.action !== SETUP_ACTION.RESTORE) return this.view;
    this.view = setupView(SETUP_STATUS.CHOICE);
    let bytes: Buffer | undefined;
    try {
      const path = await this.dialogs.select();
      if (!path || this.signal.aborted) return this.view;
      bytes = await readBackupFile(path);
      if (this.signal.aborted) return this.view;
      const restored = await this.restorer.restore(
        bytes,
        request.password,
        this.signal,
      );
      if (!this.signal.aborted) {
        this.restored = restored;
        this.view = setupView(SETUP_STATUS.RESTORED, null, restored.address);
      }
    } catch (error) {
      if (!this.signal.aborted) this.restoreFailure(error);
    } finally {
      bytes?.fill(0);
    }
    return this.view;
  }
  private restoreFailure(error: unknown) {
    if (
      error instanceof WalletRestoreError &&
      error.code === WALLET_RESTORE_ERROR.RECOVERY_REQUIRED
    )
      this.view = setupView(
        SETUP_STATUS.BLOCKED,
        SETUP_ERROR.RECOVERY_REQUIRED,
      );
    else if (
      error instanceof WalletRestoreError &&
      error.code === WALLET_RESTORE_ERROR.DESTINATION_EXISTS
    )
      this.view = setupView(SETUP_STATUS.BLOCKED, SETUP_ERROR.EXISTING);
    else this.view = setupView(SETUP_STATUS.CHOICE, SETUP_ERROR.FAILED);
  }
  async settled() {
    await this.inspection;
    await this.pending;
  }
}
export function createWalletSetup(
  root: string,
  protection: WalletProtection | null,
  dialogs: SetupDialogs,
  signal: AbortSignal,
) {
  return new WalletSetup(root, protection, dialogs, signal);
}
