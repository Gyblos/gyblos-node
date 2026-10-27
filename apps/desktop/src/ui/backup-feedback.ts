// Derives inline backup guidance from the existing bounded host request contract.
import {
  BACKUP_ACTION,
  BACKUP_FLOW,
  parseBackupRequest,
  type BackupAction,
} from '../wallet/backup-flow-model.js';

const FEEDBACK = {
  MINIMUM: `Use at least ${BACKUP_FLOW.MIN_PASSWORD_CHARACTERS} characters.`,
  TOO_LONG: `This password is too long. Use no more than ${BACKUP_FLOW.MAX_PASSWORD_BYTES} UTF-8 bytes.`,
  KEEP: 'Keep this password to restore your backup.',
  VERIFY: 'Enter the password used to create this backup.',
  CONFIRM: 'Repeat your password to confirm it.',
  MISMATCH: 'Passwords do not match.',
  MATCH: 'Passwords match.',
} as const;
export function backupPasswordFeedback(
  action: BackupAction,
  password: string,
  confirmation: string,
) {
  const creating = action === BACKUP_ACTION.CREATE;
  const valid = parseBackupRequest({ action, password }) !== null;
  const matches = password === confirmation;
  return {
    canSubmit: valid && (!creating || matches),
    passwordInvalid: password.length > 0 && !valid,
    passwordHint: !valid
      ? password.length < BACKUP_FLOW.MIN_PASSWORD_CHARACTERS
        ? FEEDBACK.MINIMUM
        : FEEDBACK.TOO_LONG
      : creating
        ? FEEDBACK.KEEP
        : FEEDBACK.VERIFY,
    confirmationInvalid: creating && confirmation.length > 0 && !matches,
    confirmationHint: !creating
      ? ''
      : !confirmation
        ? FEEDBACK.CONFIRM
        : matches
          ? FEEDBACK.MATCH
          : FEEDBACK.MISMATCH,
  };
}
