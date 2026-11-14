// Compact backup controls reuse wallet/dialog styles; only passwords and status cross IPC.
// A successful saved-file check persists identity-bound metadata, never a funding capability.
import { useId, useState } from 'react';

import {
  BACKUP_ACTION,
  BACKUP_FLOW,
  BACKUP_RESULT,
  type BackupAction,
} from '../wallet/backup-flow-model';
import { backupPasswordFeedback } from './backup-feedback';
import { BUTTON_VARIANT } from './constants';
import { FormField, FormInput } from './Form';
import { Button, Note } from './UI';
import { useDesktopWallet, useDesktopWalletActions } from './WalletState';

function useWalletBackup() {
  const wallet = useDesktopWallet();
  const [address] = useState(wallet.address);
  const actions = useDesktopWalletActions();
  const [action, setAction] = useState<BackupAction>(BACKUP_ACTION.CREATE);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const creating = action === BACKUP_ACTION.CREATE;
  async function submit() {
    if (
      busy ||
      actions.busy ||
      !backupPasswordFeedback(action, password, confirmation).canSubmit
    )
      return;
    setBusy(true);
    setMessage('');
    const request = { action, password, address };
    setPassword('');
    setConfirmation('');
    try {
      const result = address
        ? await actions.backup({ ...request, address })
        : BACKUP_RESULT.FAILED;
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
    feedback: backupPasswordFeedback(action, password, confirmation),
    creating,
    password,
    setPassword,
    confirmation,
    setConfirmation,
    busy: busy || actions.busy,
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
  hint,
  invalid = false,
}: {
  label: string;
  value: string;
  change(value: string): void;
  busy: boolean;
  creating: boolean;
  autoFocus?: boolean;
  hint?: string;
  invalid?: boolean;
}) {
  const hintId = useId();
  return (
    <FormField label={label}>
      <FormInput
        type="password"
        autoFocus={autoFocus}
        autoComplete={creating ? 'new-password' : 'off'}
        value={value}
        disabled={busy}
        maxLength={BACKUP_FLOW.MAX_PASSWORD_BYTES}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => change(event.target.value)}
      />
      {hint && (
        <small
          id={hintId}
          className="modal-note"
          role={invalid ? 'alert' : undefined}
        >
          {hint}
        </small>
      )}
    </FormField>
  );
}
export function WalletBackup() {
  const {
    feedback,
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
        {creating
          ? 'This password protects your backup file. Keep both to restore your wallet.'
          : 'Choose your saved backup and enter its password to verify this wallet.'}
      </Note>
      <div
        className="connection-location"
        role="group"
        aria-label="Backup operation"
      >
        <Button
          variant={creating ? BUTTON_VARIANT.TONAL : BUTTON_VARIANT.GHOST}
          disabled={busy}
          aria-pressed={creating}
          onClick={() => choose(BACKUP_ACTION.CREATE)}
        >
          Create backup
        </Button>
        <Button
          variant={!creating ? BUTTON_VARIANT.TONAL : BUTTON_VARIANT.GHOST}
          disabled={busy}
          aria-pressed={!creating}
          onClick={() => choose(BACKUP_ACTION.VERIFY)}
        >
          Verify saved file
        </Button>
      </div>
      <PasswordField
        label="Backup password"
        value={password}
        change={setPassword}
        busy={busy}
        creating={creating}
        hint={feedback.passwordHint}
        invalid={feedback.passwordInvalid}
      />
      {creating && (
        <PasswordField
          label="Confirm password"
          value={confirmation}
          change={setConfirmation}
          busy={busy}
          creating={creating}
          hint={feedback.confirmationHint}
          invalid={feedback.confirmationInvalid}
        />
      )}
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={busy || !feedback.canSubmit}
        onClick={() => void submit()}
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
