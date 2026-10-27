// Compact backup controls reuse wallet/dialog styles; only passwords and status cross IPC.
// A successful saved-file check persists identity-bound metadata, never a funding capability.
import { useState } from 'react';

import {
  BACKUP_ACTION,
  BACKUP_FLOW,
  BACKUP_RESULT,
  type BackupAction,
} from '../wallet/backup-flow-model.js';
import { BUTTON_VARIANT } from './constants.js';
import { Button, Note } from './UI.js';
import { useRefreshDesktopWallet } from './WalletState.js';

function useWalletBackup() {
  const refresh = useRefreshDesktopWallet();
  const [action, setAction] = useState<BackupAction>(BACKUP_ACTION.CREATE);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const creating = action === BACKUP_ACTION.CREATE;
  async function submit() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const request = { action, password };
    setPassword('');
    setConfirmation('');
    try {
      const result = await window.desktopWallet?.backup(request);
      await refresh();
      if (result === BACKUP_RESULT.SAVED) {
        setAction(BACKUP_ACTION.VERIFY);
        setMessage('File saved. Verify it to confirm your address.');
      } else if (result === BACKUP_RESULT.VERIFIED) {
        setMessage('Backup verified for this wallet.');
      } else if (result === BACKUP_RESULT.CANCELLED)
        setMessage(
          'Cancelled. Your wallet was not changed. If writing had started, the encrypted file may remain.',
        );
      else if (result === BACKUP_RESULT.BUSY)
        setMessage('A backup operation is already running.');
      else
        setMessage(
          'Could not complete the backup. Check the password, selected file and location. Existing files are never replaced.',
        );
    } catch {
      setMessage('Backup is unavailable. Your wallet was not changed.');
    } finally {
      setBusy(false);
    }
  }
  function choose(next: BackupAction) {
    setAction(next);
    setPassword('');
    setConfirmation('');
    setMessage('');
  }
  return {
    creating,
    password,
    setPassword,
    confirmation,
    setConfirmation,
    busy,
    message,
    submit,
    choose,
  };
}
export function PasswordField({
  label,
  value,
  change,
  busy,
  creating,
  autoFocus = false,
}: {
  label: string;
  value: string;
  change(value: string): void;
  busy: boolean;
  creating: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="field-label">
      {label}
      <input
        className="full-input"
        type="password"
        autoFocus={autoFocus}
        autoComplete={creating ? 'new-password' : 'off'}
        value={value}
        disabled={busy}
        maxLength={BACKUP_FLOW.MAX_PASSWORD_BYTES}
        onChange={(event) => change(event.target.value)}
      />
    </label>
  );
}
export function WalletBackup() {
  const {
    creating,
    password,
    setPassword,
    confirmation,
    setConfirmation,
    busy,
    message,
    submit,
    choose,
  } = useWalletBackup();
  return (
    <section className="wallet-details" aria-label="Encrypted backup">
      <Note>
        Keep the file and password safe. Restore is not available yet.
      </Note>
      <div
        className="connection-location"
        role="group"
        aria-label="Backup operation"
      >
        <Button
          disabled={busy}
          aria-pressed={creating}
          onClick={() => choose(BACKUP_ACTION.CREATE)}
        >
          Create backup
        </Button>
        <Button
          disabled={busy}
          aria-pressed={!creating}
          onClick={() => choose(BACKUP_ACTION.VERIFY)}
        >
          Verify saved file
        </Button>
      </div>
      <PasswordField
        label="Password · at least 12 characters"
        value={password}
        change={setPassword}
        busy={busy}
        creating={creating}
      />
      {creating && (
        <PasswordField
          label="Confirm password"
          value={confirmation}
          change={setConfirmation}
          busy={busy}
          creating={creating}
        />
      )}
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={
          busy ||
          password.length < BACKUP_FLOW.MIN_PASSWORD_CHARACTERS ||
          (creating && password !== confirmation)
        }
        onClick={() => {
          void submit();
        }}
      >
        {busy
          ? 'Working…'
          : creating
            ? 'Save encrypted file…'
            : 'Choose file and verify…'}
      </Button>
      <p className="modal-note" role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
