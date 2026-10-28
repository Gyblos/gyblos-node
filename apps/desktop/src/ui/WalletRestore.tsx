// Compact inline restore controls reuse Settings fields; all file/key work stays in the host.
import { useState } from 'react';

import {
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
} from '../wallet/settings-model';
import { validSetupPassword } from '../wallet/setup-model';
import { BUTTON_VARIANT } from './constants';
import { Button, Note } from './UI';
import { PasswordField } from './WalletBackup';
import { useDesktopWalletActions } from './WalletState';

const restoreCopy = {
  [WALLET_SETTINGS_RESULT.RESTORED]:
    'Wallet added. Choose Use wallet to switch to it.',
  [WALLET_SETTINGS_RESULT.EXISTS]: 'This wallet is already on this device.',
  [WALLET_SETTINGS_RESULT.CANCELLED]:
    'Cancelled. Your active wallet was not changed.',
  [WALLET_SETTINGS_RESULT.BUSY]: 'Another wallet operation is running.',
  [WALLET_SETTINGS_RESULT.FAILED]:
    'Could not restore. Check the file and password.',
  [WALLET_SETTINGS_RESULT.UNAVAILABLE]:
    'Protected wallet storage is unavailable.',
  [WALLET_SETTINGS_RESULT.RECOVERY_REQUIRED]:
    'Existing data was preserved. Wallet storage needs attention.',
  [WALLET_SETTINGS_RESULT.SELECTED]: 'Wallet selected.',
};
export function WalletRestore({ close }: { close: () => void }) {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const { busy, manage } = useDesktopWalletActions();
  async function restore() {
    const request = { action: WALLET_SETTINGS_ACTION.RESTORE, password };
    setPassword('');
    setMessage('');
    setMessage(restoreCopy[await manage(request)]);
  }
  return (
    <form
      className="wallet-details"
      aria-label="Restore wallet"
      onSubmit={(event) => {
        event.preventDefault();
        void restore();
      }}
    >
      <Note>
        Your current wallet stays available. Restore adds another wallet.
      </Note>
      <PasswordField
        label="Backup password"
        value={password}
        change={setPassword}
        busy={busy}
        creating={false}
        autoFocus
      />
      <div className="connection-location">
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          type="submit"
          disabled={busy || !validSetupPassword(password)}
        >
          {busy ? 'Restoring…' : 'Choose file and restore…'}
        </Button>
        <Button disabled={busy} onClick={close}>
          Done
        </Button>
      </div>
      <p className="modal-note" role="status" aria-live="polite">
        {message}
      </p>
    </form>
  );
}
