// Displays public wallet status only; backup, funding and signing remain disabled.
import { useEffect, useState } from 'react';

import {
  parseWalletSummary,
  WALLET_STATUS,
  walletSummary,
  type WalletSummary,
} from '../wallet/model.js';
import { Badge, Button, Note } from './UI.js';

declare global {
  interface Window {
    desktopWallet?: { summary(): Promise<WalletSummary> };
  }
}

export function WalletDetails() {
  const [wallet, setWallet] = useState(() =>
    walletSummary(WALLET_STATUS.LOADING),
  );
  useEffect(() => {
    let active = true;
    const request =
      window.desktopWallet?.summary() ??
      Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE));
    void request.then(
      (value) => {
        if (active) setWallet(parseWalletSummary(value));
      },
      () => {
        if (active) setWallet(walletSummary(WALLET_STATUS.UNAVAILABLE));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const ready = wallet.status === WALLET_STATUS.READY;
  return (
    <section className="wallet-details" aria-label="Wallet details">
      <div className="connection-location">
        <strong>Personal wallet</strong>
        <Badge>{ready ? 'Backup pending' : 'Not available'}</Badge>
      </div>
      {ready ? (
        <>
          <span className="field-label">Solana address · local wallet</span>
          <div className="wallet-address">
            <code>{wallet.address}</code>
          </div>
          <span className="modal-note">Balance: not queried</span>
          <Note>
            Your key is encrypted using this operating system’s secret storage.
            Portable backup and recovery are not available yet. Do not send
            funds to this address; external transfers cannot be blocked by this
            app.
          </Note>
        </>
      ) : (
        <Note>
          {wallet.status === WALLET_STATUS.LOADING
            ? 'Preparing protected wallet…'
            : wallet.status === WALLET_STATUS.RECOVERY_REQUIRED
              ? 'Wallet needs recovery. Existing data was preserved; no replacement was created.'
              : 'Protected wallet storage is unavailable. On Linux, enable GNOME Keyring or KWallet and restart. Chat remains simulated.'}
        </Note>
      )}
      <Button disabled className="wide">
        Add funds · backup verification required
      </Button>
      <Note>
        Funding stays disabled until a portable backup restores this exact
        address.
      </Note>
    </section>
  );
}
