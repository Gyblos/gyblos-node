// Compact shared-modal startup status; connection progress is explicitly simulated.
import { Globe, ShieldCheck } from '@phosphor-icons/react';

import { WALLET_STATUS, type WalletSummary } from '../wallet/model';
import { NETWORK_STATE } from './constants';
import { Modal } from './Modal';
import { SIGNAL_STATE, SignalMark } from './Signal';
import { Badge, Button, List, ListRow, Note, RowCopy } from './UI';

export function StartupScreen({
  wallet,
  network,
  onContinue,
}: {
  wallet: WalletSummary;
  network: (typeof NETWORK_STATE)[keyof typeof NETWORK_STATE];
  onContinue(): void;
}) {
  const waiting = wallet.status === WALLET_STATUS.LOADING;
  const protectedWallet = wallet.status === WALLET_STATUS.READY;
  const connected = network === NETWORK_STATE.CONNECTED;
  return (
    <Modal title="Starting Gyblos" close={onContinue} compact>
      <div className="startup-brand">
        <SignalMark state={SIGNAL_STATE.CONNECTING} />
      </div>
      <List label="Startup progress">
        <ListRow
          leading={<ShieldCheck size={17} />}
          trailing={
            <Badge>
              {waiting
                ? 'Preparing'
                : protectedWallet
                  ? 'Ready'
                  : 'Unavailable'}
            </Badge>
          }
        >
          <RowCopy
            title="Protected wallet"
            detail={
              waiting
                ? 'Preparing this device…'
                : protectedWallet
                  ? 'Stored locally · backup pending'
                  : 'You can continue to Gyblos'
            }
          />
        </ListRow>
        <ListRow
          leading={<Globe size={17} />}
          trailing={<Badge>{connected ? 'Ready' : 'Preparing'}</Badge>}
        >
          <RowCopy title="Network" detail="Connecting to Gyblos" />
        </ListRow>
      </List>
      <Button className="wide" onClick={onContinue}>
        Continue
      </Button>
      <Note>You can continue while setup finishes.</Note>
    </Modal>
  );
}
