import { PaypalLogo, Wallet } from '@phosphor-icons/react';

import { DEVNET } from '@gyblos/config/network';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import {
  paypalPaymentSummary,
  paypalSessionCanConnectAgent,
} from '../paypal-model';
import { fundingAmount } from './BuyerFunding';
import { BUTTON_VARIANT } from './constants';
import { displayDollars } from './history-presentation';
import { TONE } from './status-tone';
import { Tag } from './Tag';
import { Button } from './UI';
import type { useBuyerFunding } from './useBuyerFunding';
import type { PaypalSessionView } from './usePaypalSession';

export function WalletOverview({
  observation,
  onAddFunds,
  onDetails,
}: {
  observation: ReturnType<typeof useBuyerFunding>;
  onAddFunds(): void;
  onDetails(): void;
}) {
  const { funding, loading } = observation;
  const balance = funding?.balanceAtomic;
  return (
    <li className="preview-method-row" aria-label="USDC buyer wallet">
      <span className="ui-icon-tile" aria-hidden="true">
        <Wallet size={18} />
      </span>
      <div className="preview-method-copy">
        <span className="preview-method-name">
          <h3>USDC wallet</h3>
          <Tag dot>
            {' '}
            {funding?.network === DEVNET ? 'Devnet' : 'Buyer wallet'}{' '}
          </Tag>
        </span>
        <span className="ui-help-text">
          {loading
            ? 'Checking balance…'
            : balance != null
              ? fundingAmount(balance)
              : 'Balance unavailable'}
        </span>
      </div>
      <div className="preview-method-actions">
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={!funding}
          onClick={onAddFunds}
        >
          Add funds
        </Button>
        <Button
          onClick={() => {
            observation.refresh();
            onDetails();
          }}
        >
          Details
        </Button>
      </div>
    </li>
  );
}
export function PaypalSummary({
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
    <li className="preview-method-row" aria-label="PayPal payment method">
      <span className="ui-icon-tile" aria-hidden="true">
        <PaypalLogo size={18} />
      </span>
      <div className="preview-method-copy">
        <div className="preview-method-name">
          <h3>PayPal</h3>
          <Tag tone={TONE.WARNING}>Sandbox</Tag>
        </div>
        <p className="ui-help-text">
          {summary.label} ·{' '}
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
      <div className="preview-method-actions">
        <Button
          variant={BUTTON_VARIANT.SECONDARY}
          disabled={session.state.busy}
          onClick={onManage}
        >
          {paypalManageLabel(session)}
        </Button>
      </div>
    </li>
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
