// Composes wallet metadata and the guarded shared PayPal session. Navigation never starts a payment.
import { PaypalLogo } from '@phosphor-icons/react';
import { useState } from 'react';

import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';
import { DEVNET } from '@gyblos/config/network';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import { depositShortfall } from '../funding/model';
import {
  managePaypal,
  PAYMENT_METHOD,
  paypalPaymentSummary,
  paypalSessionCanConnectAgent,
  type PaymentMethod,
} from '../paypal-model';
import { BuyerFundingAddress, fundingAmount } from './BuyerFunding';
import { BUTTON_VARIANT } from './constants';
import { FormActions } from './Form';
import { displayDollars } from './history-presentation';
import { Modal } from './Modal';
import { PaypalSessionPanel } from './PaypalSessionPanel';
import { SpendingHistory } from './SpendingHistory';
import { Badge, Button, PagePanel } from './UI';
import type { ActivityView } from './useActivity';
import { useBuyerFunding } from './useBuyerFunding';
import type { PaypalSessionView } from './usePaypalSession';
import type { X402View } from './useX402';
import { WalletDetails } from './WalletDetails';
import { X402Payments } from './X402Payments';

type Props = {
  x402?: X402View;
  session: PaypalSessionView;
  activity: ActivityView;
  managePaypal: boolean;
  onManagePaypal(open: boolean): void;
  onChat(): void;
  onConnections(): void;
  onActivity(id?: string): void;
  onBackup(): void;
  onAddFunds(): void;
  onPaymentMethod(method: PaymentMethod): boolean;
};
export function Payments(props: Props) {
  const [walletOpen, setWalletOpen] = useState(false);
  return (
    <PagePanel>
      {props.x402 && (
        <X402Payments
          buyer={props.x402}
          onChat={() => {
            if (props.onPaymentMethod(PAYMENT_METHOD.USDC)) props.onChat();
          }}
        />
      )}
      <WalletOverview
        buyer={props.x402}
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
  buyer,
  onAddFunds,
  onDetails,
}: {
  buyer?: X402View;
  onAddFunds(): void;
  onDetails(): void;
}) {
  const { funding, loading, refresh } = useBuyerFunding(
    buyer?.state.policy?.payer,
  );
  const balance = funding?.balanceAtomic;
  const needed =
    balance != null
      ? depositShortfall(
          balance,
          buyer?.state.policy?.depositAtomic ??
            BUYER_SESSION_DEFAULT_POLICY.depositAtomic,
        )
      : null;
  return (
    <section className="ui-section ui-wallet-overview" aria-label="USDC wallet">
      <div className="ui-section-title">
        <h2>USDC buyer wallet</h2>
      </div>
      <div className="ui-wallet-summary">
        <div>
          <span className="ui-help-text">
            {funding?.network === DEVNET
              ? 'Devnet balance'
              : 'Available balance'}
          </span>
          <strong className="ui-wallet-amount">
            {loading
              ? 'Checking…'
              : balance != null
                ? fundingAmount(balance)
                : 'Unavailable'}
          </strong>
          {needed && needed !== '0' && (
            <p>Add {fundingAmount(needed)} to open a new channel.</p>
          )}
        </div>
        <FormActions align="start">
          <Button
            variant={BUTTON_VARIANT.PRIMARY}
            disabled={!funding}
            onClick={onAddFunds}
          >
            Add funds
          </Button>
          <Button disabled={loading} onClick={refresh}>
            Refresh balance
          </Button>
          <Button onClick={onDetails}>Desktop wallet details</Button>
        </FormActions>
      </div>
      {funding && <BuyerFundingAddress funding={funding} />}
    </section>
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
