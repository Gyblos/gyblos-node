// Explains backup password requirements before any host action is available.
import assert from 'node:assert/strict';
import test from 'node:test';

import { backupPasswordFeedback } from '@gyblos/desktop/backup-feedback';
import { BACKUP_ACTION } from '@gyblos/desktop/wallet';

void test('backup creation explains short, missing and mismatched confirmation', () => {
  const empty = backupPasswordFeedback(BACKUP_ACTION.CREATE, '', '');
  assert.equal(empty.canSubmit, false);
  assert.match(empty.passwordHint, /12 characters/);
  assert.equal(empty.confirmationInvalid, false);
  const short = backupPasswordFeedback(BACKUP_ACTION.CREATE, 'short', 'short');
  assert.equal(short.canSubmit, false);
  assert.equal(short.passwordInvalid, true);
  const missing = backupPasswordFeedback(
    BACKUP_ACTION.CREATE,
    'synthetic-password',
    '',
  );
  assert.match(missing.confirmationHint, /Repeat your password/);
  assert.equal(missing.canSubmit, false);
  const mismatch = backupPasswordFeedback(
    BACKUP_ACTION.CREATE,
    'synthetic-password',
    'different-password',
  );
  assert.equal(mismatch.confirmationInvalid, true);
  assert.equal(mismatch.canSubmit, false);
  assert.match(mismatch.confirmationHint, /do not match/);
});
void test('editing either field clears or restores mismatch without permitting invalid submission', () => {
  const matching = backupPasswordFeedback(
    BACKUP_ACTION.CREATE,
    'synthetic-password',
    'synthetic-password',
  );
  assert.equal(matching.canSubmit, true);
  assert.equal(matching.confirmationInvalid, false);
  assert.match(matching.confirmationHint, /Passwords match/);
  assert.equal(
    backupPasswordFeedback(
      BACKUP_ACTION.CREATE,
      'synthetic-passwor',
      'synthetic-password',
    ).canSubmit,
    false,
  );
  assert.equal(
    backupPasswordFeedback(
      BACKUP_ACTION.CREATE,
      'synthetic-password',
      'synthetic-passwor',
    ).canSubmit,
    false,
  );
  assert.equal(
    backupPasswordFeedback(
      BACKUP_ACTION.CREATE,
      'x'.repeat(1025),
      'x'.repeat(1025),
    ).canSubmit,
    false,
  );
  assert.equal(
    backupPasswordFeedback(
      BACKUP_ACTION.CREATE,
      '🔐'.repeat(300),
      '🔐'.repeat(300),
    ).canSubmit,
    false,
  );
  const verify = backupPasswordFeedback(
    BACKUP_ACTION.VERIFY,
    'synthetic-password',
    '',
  );
  assert.equal(verify.canSubmit, true);
  assert.equal(verify.confirmationInvalid, false);
  assert.match(verify.passwordHint, /used to create/);
});
