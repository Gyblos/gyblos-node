// Displays public wallet metadata; funding and signing remain disabled.
import { Archive, Plus } from '@phosphor-icons/react';
import { useEffect } from 'react';

import { WALLET_STATUS, type WalletSummary } from '../wallet/model';
import { BUTTON_VARIANT } from './constants';
import { CopyButton } from './CopyButton';
import { Badge, Button, List, ListRow, Note, RowCopy } from './UI';
import { useDesktopWallet, useRefreshDesktopWallet } from './WalletState';

async function copyAddress(address: string) {
  if (!(await window.desktopWallet?.copyAddress(address)))
    throw new Error('Address copy unavailable.');
}

function WalletFacts({ address }: Pick<WalletSummary, 'address'>) {
  return (
    <dl className="wallet-facts">
      <div className="wallet-fact-address">
        <dt>Solana address</dt>
        <dd className="wallet-address">
          <code>{address ?? 'Not available'}</code>
          {address && (
            <CopyButton
              key={address}
              value={address}
              label="Copy address"
              writeText={copyAddress}
            />
          )}
        </dd>
      </div>
      <div>
        <dt>Private key</dt>
        <dd>Protected on this device</dd>
      </div>
      <div>
        <dt>Network</dt>
        <dd>Solana</dd>
      </div>
    </dl>
  );
}

export function WalletDetails({
  onBackup,
  onAddFunds,
}: {
  onBackup: () => void;
  onAddFunds: () => void;
}) {
  const wallet = useDesktopWallet();
  const refresh = useRefreshDesktopWallet();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const ready = wallet.status === WALLET_STATUS.READY;
  return (
    <section className="wallet-details" aria-label="Wallet details">
      <div className="connection-location">
        <strong>On this device</strong>
        <Badge warm={ready && !wallet.backupVerified}>
          {ready
            ? wallet.backupVerified
              ? 'Backup verified'
              : 'Backup needed'
            : 'Not available'}
        </Badge>
      </div>
      <div className="settings-restriction wallet-balance">
        <div>
          <span>Available balance</span>
          <strong>
            0.0 <small>USDC</small>
          </strong>
        </div>
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={!ready}
          onClick={onAddFunds}
        >
          <Plus size={16} aria-hidden="true" /> Add funds
        </Button>
      </div>
      {ready ? (
        <WalletFacts address={wallet.address} />
      ) : (
        <Note>
          {wallet.status === WALLET_STATUS.LOADING
            ? 'Preparing protected wallet…'
            : wallet.status === WALLET_STATUS.RECOVERY_REQUIRED
              ? 'Wallet needs recovery. Existing data was preserved; no replacement was created.'
              : 'Protected wallet storage is unavailable. On Linux, enable GNOME Keyring or KWallet and restart. You can still use free models.'}
        </Note>
      )}
      <List label="Wallet recovery">
        <ListRow
          leading={null}
          trailing={
            <Button
              variant={BUTTON_VARIANT.TONAL}
              disabled={!ready}
              onClick={onBackup}
            >
              <Archive size={16} aria-hidden="true" />
              Back up wallet
            </Button>
          }
        >
          <RowCopy
            title="Recovery backup"
            detail={
              !ready
                ? 'Available when your wallet is ready.'
                : wallet.backupVerified
                  ? 'A recovery file has been verified for this wallet.'
                  : 'Create a recovery file and verify it.'
            }
          />
        </ListRow>
      </List>
    </section>
  );
}
