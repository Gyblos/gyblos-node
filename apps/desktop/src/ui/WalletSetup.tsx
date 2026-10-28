// Compact first-run controls; only a bounded password and public status cross the bridge.
// Native selection and all key/file processing remain in the host.
import { useEffect, useState } from 'react';

import { themeStyle } from '../theme';
import {
  parseSetupView,
  SETUP_ACTION,
  SETUP_ERROR,
  SETUP_STATUS,
  validSetupPassword,
  type SetupRequest,
  type SetupView,
} from '../wallet/setup-model';
import { BUTTON_VARIANT } from './constants';
import { StartupSplash } from './StartupSplash';
import { Button, Note } from './UI';
import { PasswordField } from './WalletBackup';

declare global {
  interface Window {
    desktopWalletSetup?: { run(request: SetupRequest): Promise<SetupView> };
  }
}
const errorCopy = {
  [SETUP_ERROR.FAILED]:
    'Could not restore. Check the backup file and password.',
  [SETUP_ERROR.BUSY]: 'A wallet operation is already running.',
  [SETUP_ERROR.EXISTING]:
    'A wallet now exists on this device. It was not replaced.',
  [SETUP_ERROR.RECOVERY_REQUIRED]:
    'Interrupted wallet state was retained. It needs inspection before recovery.',
};
function useWalletSetup() {
  const [view, setView] = useState<SetupView | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void window.desktopWalletSetup?.run({ action: SETUP_ACTION.STATUS }).then(
      (value) => {
        if (active) setView(parseSetupView(value));
      },
      () => {
        if (active) setView(parseSetupView(null));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  async function submit(request: SetupRequest) {
    if (busy) return;
    setBusy(true);
    setPassword('');
    try {
      setView(parseSetupView(await window.desktopWalletSetup?.run(request)));
    } catch {
      setView(parseSetupView(null));
    } finally {
      setBusy(false);
    }
  }
  return { view, restoring, setRestoring, password, setPassword, busy, submit };
}

function SetupActions({ setup }: { setup: ReturnType<typeof useWalletSetup> }) {
  const { view, password, setPassword, setRestoring, busy, restoring, submit } =
    setup;
  if (!view) return null;
  const restored = view.status === SETUP_STATUS.RESTORED;
  const blocked = view.status === SETUP_STATUS.BLOCKED;
  return restored || blocked ? (
    <Button
      variant={BUTTON_VARIANT.PRIMARY}
      onClick={() => {
        void submit({ action: SETUP_ACTION.CONTINUE });
      }}
    >
      {blocked ? 'Continue without wallet access' : 'Open Gyblos'}
    </Button>
  ) : restoring ? (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ action: SETUP_ACTION.RESTORE, password });
      }}
    >
      <PasswordField
        label="Backup password"
        value={password}
        change={setPassword}
        busy={busy}
        creating={false}
        autoFocus
      />
      <Button
        type="submit"
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={!validSetupPassword(password)}
      >
        Choose file and restore…
      </Button>
      <Button
        onClick={() => {
          setPassword('');
          setRestoring(false);
        }}
      >
        Back
      </Button>
    </form>
  ) : (
    <div className="wallet-setup-actions">
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        autoFocus
        onClick={() => {
          void submit({ action: SETUP_ACTION.CREATE });
        }}
      >
        Create wallet
      </Button>
      <Button onClick={() => setRestoring(true)}>Restore backup</Button>
    </div>
  );
}

export function WalletSetup() {
  const setup = useWalletSetup();
  const { view, busy, restoring } = setup;
  if (!view || busy || view.status === SETUP_STATUS.COMPLETE)
    return <StartupSplash />;
  const restored = view.status === SETUP_STATUS.RESTORED;
  const blocked = view.status === SETUP_STATUS.BLOCKED;
  return (
    <main
      className="desktop-frame startup-splash wallet-setup"
      style={themeStyle(false)}
    >
      <div className="startup-splash-brand">
        <span>[g]</span> Gyblos
      </div>
      <h1>
        {restored
          ? 'Wallet restored'
          : blocked
            ? 'Wallet protected'
            : restoring
              ? 'Restore your wallet'
              : 'Your wallet'}
      </h1>
      <Note>
        {restored
          ? 'This is the address recovered from your encrypted backup.'
          : 'Gyblos keeps your wallet on this device. Existing wallets are never replaced.'}
      </Note>
      {restored && <code className="wallet-setup-address">{view.address}</code>}
      {view.error && (
        <p className="modal-note" role="alert">
          {errorCopy[view.error]}
        </p>
      )}
      <SetupActions setup={setup} />
      <small>Funding stays disabled. Network preview is simulated.</small>
    </main>
  );
}
