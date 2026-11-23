// Composes wallet metadata and the guarded shared PayPal session. Navigation never starts a payment.
import { PaypalLogo } from '@phosphor-icons/react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';

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
import { SpendingOverview } from './SpendingOverview';
import { Badge, Button, PagePanel } from './UI';
import type { ActivityView } from './useActivity';
import { useBuyerFunding } from './useBuyerFunding';
import type { PaypalSessionView } from './usePaypalSession';
import type { X402View } from './useX402';
import { WalletDetails } from './WalletDetails';
import { X402History, X402Payments } from './X402Payments';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Usage' },
  { id: 'history', label: 'Payments' },
  { id: 'limits', label: 'Limits' },
] as const;
type Tab = (typeof TABS)[number]['id'];
function TabBar({ tab, onTab }: { tab: Tab; onTab(tab: Tab): void }) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index =
      (TABS.findIndex((item) => item.id === tab) + step + TABS.length) %
      TABS.length;
    const next = TABS[index];
    if (!next) return;
    onTab(next.id);
    document.getElementById('preview-tab-' + next.id)?.focus();
  };
  return (
    <div
      className="preview-tabs"
      role="tablist"
      aria-label="Usage and payments sections"
      onKeyDown={move}
    >
      {TABS.map((item) => (
        <button
          key={item.id}
          id={'preview-tab-' + item.id}
          type="button"
          role="tab"
          className="preview-tab"
          aria-selected={tab === item.id}
          aria-controls="preview-tab-panel"
          tabIndex={tab === item.id ? 0 : -1}
          onClick={() => onTab(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

type Props = {
  initialTab?: Tab;
  usage: ReactNode;
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
  const [tab, setTab] = useState<Tab>(props.initialTab ?? 'overview');
  const [walletOpen, setWalletOpen] = useState(false);
  return (
    <PagePanel>
      <TabBar tab={tab} onTab={setTab} />
      <div
        className="preview-tab-panel"
        role="tabpanel"
        id="preview-tab-panel"
        aria-labelledby={'preview-tab-' + tab}
      >
        {tab === 'activity' && props.usage}
        {tab === 'limits' && props.x402 && (
          <X402Payments
            buyer={props.x402}
            onChat={() => {
              if (props.onPaymentMethod(PAYMENT_METHOD.USDC)) props.onChat();
            }}
          />
        )}
        {tab === 'overview' && (
          <>
            <SpendingOverview
              buyer={props.x402}
              onLimits={() => setTab('limits')}
            />
            <WalletOverview
              buyer={props.x402}
              onAddFunds={props.onAddFunds}
              onDetails={() => setWalletOpen(true)}
            />
            <PaypalSummary
              session={props.session}
              onManage={() => {
                managePaypal(props.onPaymentMethod, () =>
                  props.onManagePaypal(true),
                );
              }}
            />
          </>
        )}
        {tab === 'history' && props.x402 && <X402History buyer={props.x402} />}
        {tab === 'history' && (
          <SpendingHistory
            activity={props.activity}
            onActivity={props.onActivity}
          />
        )}
      </div>
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
