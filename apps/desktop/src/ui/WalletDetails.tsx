// Displays public wallet metadata and backup controls; funding and signing remain disabled.
import { WALLET_STATUS } from '../wallet/model.js';
import { Badge, Button, Note } from './UI.js';
import { WalletBackup } from './WalletBackup.js';
import { useDesktopWallet } from './WalletState.js';

export function WalletDetails() {
  const wallet = useDesktopWallet();
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
            Your local key is protected. Do not send funds: this app cannot
            block external transfers.
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
      {ready && <WalletBackup />}
      <Button disabled className="wide">
        Add funds · disabled in this build
      </Button>
      <Note>
        Funding is disabled in this experimental build, even after a successful
        file check.
      </Note>
    </section>
  );
}
