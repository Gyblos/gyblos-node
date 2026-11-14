// Shows local readiness in a sidebar dialog; never starts payments or changes wallet custody.
import { useState, type ComponentProps } from 'react';

import { LOCAL_NODE_STATE } from '../node-status';
import { WALLET_STATUS } from '../wallet/model';
import { SIDEBAR_ACTION } from './constants';
import { Modal } from './Modal';
import { NetworkStatus } from './NetworkStatus';
import { SidebarActionIcon } from './SidebarActionIcon';
import { Button } from './UI';
import { useDesktopWallet } from './WalletState';

type Props = ComponentProps<typeof NetworkStatus> & { onPayments(): void };
export function SystemStatus({ state, onRetry, onPayments }: Props) {
  const [open, setOpen] = useState(false);
  const wallet = useDesktopWallet();
  const attention =
    state !== LOCAL_NODE_STATE.READY ||
    wallet.status !== WALLET_STATUS.READY ||
    !wallet.backupVerified;
  return (
    <>
      <Button
        className="ui-nav-row ui-system-status ui-sidebar-motion-control"
        aria-label="System status"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <SidebarActionIcon kind={SIDEBAR_ACTION.STATUS} />
        <span>System status</span>
        <span
          className="ui-attention-dot"
          data-attention={attention}
          aria-hidden="true"
        />
      </Button>
      {open && (
        <Modal title="System status" close={() => setOpen(false)}>
          <div className="ui-section">
            <section className="ui-status-item">
              <h3>Local node</h3>
              <NetworkStatus state={state} onRetry={onRetry} />
            </section>
            <section className="ui-status-item">
              <h3>Wallet</h3>
              <p className="ui-help-text">
                {wallet.status === WALLET_STATUS.READY
                  ? wallet.backupVerified
                    ? 'Protected wallet ready.'
                    : 'Recovery backup needed.'
                  : 'Protected wallet unavailable.'}
              </p>
              <Button
                onClick={() => {
                  setOpen(false);
                  onPayments();
                }}
              >
                Manage wallet
              </Button>
            </section>
          </div>
        </Modal>
      )}
    </>
  );
}
