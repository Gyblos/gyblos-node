// Composes wallet metadata and the guarded shared PayPal session. Navigation never starts a payment.
import { PaypalLogo } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import {
  managePaypal,
  PAYMENT_METHOD,
  paypalPaymentSummary,
  paypalSessionCanConnectAgent,
} from '../paypal-model';
import { WALLET_STATUS } from '../wallet/model';
import { BUTTON_VARIANT } from './constants';
import { CopyField, FormActions } from './Form';
import { displayDollars } from './history-presentation';
import { Modal } from './Modal';
import { PaypalSessionPanel } from './PaypalSessionPanel';
import { SpendingHistory } from './SpendingHistory';
import { Badge, Button, PagePanel } from './UI';
import type { ActivityView } from './useActivity';
import type { PaypalSessionView } from './usePaypalSession';
import { WalletDetails } from './WalletDetails';
import { useDesktopWallet } from './WalletState';

type Props = {
  session: PaypalSessionView;
  activity: ActivityView;
  managePaypal: boolean;
  onManagePaypal(open: boolean): void;
  onChat(): void;
  onConnections(): void;
  onActivity(id?: string): void;
  onBackup(): void;
  onAddFunds(): void;
  onPaymentMethod(method: typeof PAYMENT_METHOD.PAYPAL): boolean;
};
export function Payments(props: Props) {
  const [walletOpen, setWalletOpen] = useState(false);
  return (
    <PagePanel>
      <WalletOverview
        onAddFunds={props.onAddFunds}
        onDetails={() => setWalletOpen(true)}
      />
      <PaypalSummary
        session={props.session}
        onManage={() => {
          managePaypal(props.onPaymentMethod, () => props.onManagePaypal(true));
        }}
      />
      <SpendingHistory
        activity={props.activity}
        onActivity={props.onActivity}
      />
      {props.managePaypal && (
        <Modal title="PayPal Sandbox" close={() => props.onManagePaypal(false)}>
          <PaypalSessionPanel
            session={props.session}
            onChat={() => {
              props.onManagePaypal(false);
              props.onChat();
            }}
          />
          <FormActions align="start">
            <Button
              onClick={() => {
                props.onManagePaypal(false);
                props.onConnections();
              }}
            >
              Connect a tool
            </Button>
          </FormActions>
        </Modal>
      )}
      {walletOpen && (
        <Modal title="Wallet details" close={() => setWalletOpen(false)}>
          <WalletDetails
            onBackup={() => {
              setWalletOpen(false);
              props.onBackup();
            }}
            onAddFunds={() => {
              setWalletOpen(false);
              props.onAddFunds();
            }}
          />
        </Modal>
      )}
    </PagePanel>
  );
}
function WalletOverview({
  onAddFunds,
  onDetails,
}: {
  onAddFunds(): void;
  onDetails(): void;
}) {
  const wallet = useDesktopWallet();
  const ready = wallet.status === WALLET_STATUS.READY;
  return (
    <section className="ui-section ui-wallet-overview" aria-label="USDC wallet">
      <div className="ui-section-title">
        <h2>USDC wallet</h2>
        <Badge>
          {ready
            ? wallet.backupVerified
              ? 'Backup verified'
              : 'Backup needed'
            : 'Not available'}
        </Badge>
      </div>
      <div className="ui-wallet-summary">
        <div>
          <span className="ui-help-text">Available balance</span>
          <strong className="ui-wallet-amount">
            — <small>USDC</small>
          </strong>
        </div>
        <FormActions align="start">
          <Button
            variant={BUTTON_VARIANT.PRIMARY}
            disabled={!wallet.fundingEnabled}
            onClick={onAddFunds}
          >
            Add funds
          </Button>
          <Button onClick={() => onDetails()}>Wallet details</Button>
        </FormActions>
      </div>
      <WalletAddress />
    </section>
  );
}
function WalletAddress() {
  const wallet = useDesktopWallet();
  const [notice, setNotice] = useState('');
  return (
    <>
      {' '}
      <CopyField
        id="wallet-address"
        label="Wallet address · Solana"
        value={wallet.address ?? 'Not available'}
        actionLabel="Copy address"
        disabled={!wallet.address}
        onCopy={() => {
          if (wallet.address)
            void window.desktopWallet
              ?.copyAddress(wallet.address)
              .then((ok) =>
                setNotice(ok ? 'Address copied.' : 'Could not copy address.'),
              )
              .catch(() => setNotice('Could not copy address.'));
        }}
      />
      <p className="ui-help-text">
        Balance and USDC transaction history are not available in this version.
      </p>
      <span className="sr-only" role="status">
        {notice}
      </span>
    </>
  );
}
function PaypalSummary({
  session,
  onManage,
}: {
  session: PaypalSessionView;
  onManage(): void;
}) {
  const summary = paypalPaymentSummary(
    session.state.status,
    session.state.statusFresh,
    session.state.busy,
  );
  return (
    <section className="ui-paypal-summary" aria-label="PayPal payment method">
      <span className="ui-icon-tile" aria-hidden="true">
        <PaypalLogo size={22} />
      </span>
      <div className="ui-paypal-summary-copy">
        <div className="ui-inline-actions">
          <h2>PayPal</h2>
          <Badge>Sandbox</Badge>
        </div>
        <strong
          className="ui-status-line"
          data-ready={paypalSessionCanConnectAgent(
            session.state.status,
            session.state.statusFresh,
            session.state.busy,
          )}
        >
          {summary.label}
        </strong>
        <p className="ui-help-text">
          {summary.limitCents === null
            ? 'One approval for multiple replies and tool requests.'
            : (summary.usedCents === null
                ? 'Unconfirmed usage'
                : displayDollars(summary.usedCents)) +
              ' recorded · ' +
              displayDollars(summary.limitCents) +
              ' limit'}
        </p>
      </div>
      <Button
        variant={BUTTON_VARIANT.SECONDARY}
        disabled={session.state.busy}
        onClick={onManage}
      >
        {paypalManageLabel(session)}
      </Button>
    </section>
  );
}

function paypalManageLabel(session: PaypalSessionView) {
  const phase = session.state.statusFresh
    ? session.state.status?.phase
    : undefined;
  if (
    phase === PAYPAL_SESSION_STATUS.READY ||
    phase === PAYPAL_SESSION_PHASE.COMPLETED ||
    phase === PAYPAL_SESSION_PHASE.VOIDED ||
    phase === PAYPAL_SESSION_PHASE.CANCELLED
  )
    return 'Authorize';
  if (phase === PAYPAL_SESSION_PHASE.CREATED) return 'Finish approval';
  return paypalSessionCanConnectAgent(
    session.state.status,
    session.state.statusFresh,
    session.state.busy,
  )
    ? 'Manage session'
    : 'Review session';
}
