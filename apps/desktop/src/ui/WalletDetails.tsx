// Displays public wallet metadata; funding and signing remain disabled.
import {
  Archive,
  ArrowCounterClockwise,
  CheckCircle,
  Plus,
  Warning,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';

import { depositShortfall } from '../funding/model';
import { WALLET_STATUS, type WalletSummary } from '../wallet/model';
import { BuyerFundingAddress, fundingAmount } from './BuyerFunding';
import { BUTTON_VARIANT } from './constants';
import { CopyButton } from './CopyButton';
import { MotionPresence } from './Motion';
import { Badge, Button, List, ListRow, Note, RowCopy } from './UI';
import { useBuyerFunding } from './useBuyerFunding';
import { WalletRestore } from './WalletRestore';
import { WalletSelector } from './WalletSelector';
import {
  useDesktopWallet,
  useDesktopWalletActions,
  useRefreshDesktopWallet,
} from './WalletState';

async function copyAddress(address: string) {
  if (!(await window.desktopWallet?.copyAddress(address)))
    throw new Error('Address copy unavailable.');
}

function WalletFacts({ address }: Pick<WalletSummary, 'address'>) {
  return (
    <dl className="wallet-facts">
      <div className="wallet-fact-address">
        <dt>Wallet address</dt>
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
    </dl>
  );
}

export function WalletDetails({
  onBackup,
  onAddFunds,
  payer,
  depositAtomic = BUYER_SESSION_DEFAULT_POLICY.depositAtomic,
}: {
  payer?: string;
  depositAtomic?: string;
  onBackup: () => void;
  onAddFunds: () => void;
}) {
  const wallet = useDesktopWallet();
  const { funding, loading, refresh: refreshFunding } = useBuyerFunding(payer);
  const shortfall =
    funding?.balanceAtomic == null
      ? null
      : depositShortfall(funding.balanceAtomic, depositAtomic);
  const refresh = useRefreshDesktopWallet();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { busy } = useDesktopWalletActions();
  const ready = wallet.status === WALLET_STATUS.READY;
  const locked = wallet.status === WALLET_STATUS.LOCKED;
  return (
    <section className="wallet-details" aria-label="Wallet details">
      <BuyerWallet
        {...{ funding, shortfall, busy, loading, refreshFunding, onAddFunds }}
      />
      <section className="ui-section" aria-label="Protected desktop wallet">
        <h3>Protected desktop wallet</h3>
        <div className="connection-location">
          <Badge warm={ready && !wallet.backupVerified}>
            {ready
              ? wallet.backupVerified
                ? 'Backup verified'
                : 'Backup needed'
              : locked
                ? 'Locked'
                : 'Not available'}
          </Badge>
        </div>
        {wallet.address && funding && wallet.address !== funding.payer && (
          <p className="ui-help-text">
            The buyer uses a different address. This backup covers the protected
            desktop wallet.
          </p>
        )}
        {locked ? (
          <WalletAccess />
        ) : ready ? (
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
        {wallet.status === WALLET_STATUS.UNAVAILABLE && <WalletAccess />}
        <WalletSelector />
        <WalletRecovery ready={ready} onBackup={onBackup} />
      </section>
    </section>
  );
}

function WalletAccess() {
  const { busy, activate } = useDesktopWalletActions();
  return (
    <section className="ui-section" aria-label="Unlock protected wallet">
      <Note>
        Free chat works without this wallet. Continue only when you want to use
        its wallet or backup features. Gyblos will explain your device's secure
        storage prompt before opening it. No payment is authorized here.
      </Note>
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={busy}
        onClick={() => void activate()}
      >
        {busy ? 'Waiting for device approval…' : 'Set up or unlock wallet'}
      </Button>
    </section>
  );
}

function WalletRecovery({
  ready,
  onBackup,
}: {
  ready: boolean;
  onBackup: () => void;
}) {
  const wallet = useDesktopWallet();
  const { busy } = useDesktopWalletActions();
  const [restoring, setRestoring] = useState(false);
  return (
    <>
      <List label="Wallet recovery">
        <ListRow
          leading={
            ready && wallet.backupVerified ? (
              <CheckCircle
                size={20}
                weight="fill"
                className="backup-verified-icon"
                aria-hidden="true"
              />
            ) : ready ? (
              <Warning
                size={20}
                weight="fill"
                className="backup-needed-icon"
                aria-hidden="true"
              />
            ) : null
          }
          trailing={
            <Button
              variant={BUTTON_VARIANT.TONAL}
              disabled={!ready || busy}
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
                  : 'No verified backup yet. Back up this wallet to recover it later.'
            }
          />
        </ListRow>
        <ListRow
          leading={null}
          trailing={
            <Button
              variant={BUTTON_VARIANT.TONAL}
              disabled={!ready || busy}
              onClick={() => setRestoring((value) => !value)}
            >
              <ArrowCounterClockwise size={16} aria-hidden="true" />
              Restore backup
            </Button>
          }
        >
          <RowCopy
            title="Restore a wallet"
            detail="Add a saved wallet without replacing this one."
          />
        </ListRow>
      </List>
      <MotionPresence>
        {restoring && <WalletRestore close={() => setRestoring(false)} />}
      </MotionPresence>
    </>
  );
}

function BuyerWallet({
  funding,
  shortfall,
  busy,
  loading,
  refreshFunding,
  onAddFunds,
}: {
  funding: ReturnType<typeof useBuyerFunding>['funding'];
  shortfall: string | null;
  busy: boolean;
  loading: boolean;
  refreshFunding(): void;
  onAddFunds(): void;
}) {
  return (
    <section className="ui-section" aria-label="Buyer wallet">
      <h3>Buyer wallet</h3>
      <div className="settings-restriction wallet-balance">
        <div>
          <span>Available balance</span>
          <strong>
            {funding?.balanceAtomic == null
              ? 'Unavailable'
              : fundingAmount(funding.balanceAtomic)}
          </strong>
        </div>
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={!funding || busy}
          onClick={onAddFunds}
        >
          <Plus size={16} aria-hidden="true" /> Add funds
        </Button>
      </div>
      {shortfall && shortfall !== '0' && (
        <p>Add {fundingAmount(shortfall)} to open a new channel.</p>
      )}
      {funding && <BuyerFundingAddress funding={funding} />}
      <Button disabled={loading} onClick={refreshFunding}>
        Refresh balance
      </Button>
    </section>
  );
}
