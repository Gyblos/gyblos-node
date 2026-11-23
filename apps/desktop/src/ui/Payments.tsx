// Composes wallet metadata and the guarded shared PayPal session. Navigation never starts a payment.
import { useState, type ReactNode } from 'react';

import {
  managePaypal,
  PAYMENT_METHOD,
  type PaymentMethod,
} from '../paypal-model';
import { FormActions } from './Form';
import { Modal } from './Modal';
import { PaypalSummary, WalletOverview } from './PaymentMethods';
import { TabBar, type Tab } from './PaymentTabs';
import { PaypalSessionPanel } from './PaypalSessionPanel';
import { SpendingHistory } from './SpendingHistory';
import { SpendingOverview } from './SpendingOverview';
import { Button, PagePanel } from './UI';
import type { ActivityView } from './useActivity';
import type { PaypalSessionView } from './usePaypalSession';
import type { X402View } from './useX402';
import { WalletDetails } from './WalletDetails';
import { X402History, X402Payments } from './X402Payments';

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
            <section className="ui-section" aria-label="Payment methods">
              <div className="ui-section-title">
                <h2>Payment methods</h2>
              </div>
              <ul className="preview-method-list">
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
              </ul>
            </section>
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
