// Lists public saved identities; selection is explicit and never merges funds.
import { useState } from 'react';

import {
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
} from '../wallet/settings-model.js';
import { BUTTON_VARIANT } from './constants.js';
import { Badge, Button, List, ListRow, RowCopy } from './UI.js';
import {
  useDesktopWallet,
  useDesktopWalletActions,
  useDesktopWallets,
} from './WalletState.js';

export function WalletSelector() {
  const wallet = useDesktopWallet();
  const wallets = useDesktopWallets();
  const { busy, manage } = useDesktopWalletActions();
  const [error, setError] = useState('');
  async function select(address: string) {
    setError('');
    const result = await manage({
      action: WALLET_SETTINGS_ACTION.SELECT,
      address,
    });
    if (result !== WALLET_SETTINGS_RESULT.SELECTED)
      setError(
        result === WALLET_SETTINGS_RESULT.BUSY
          ? 'Another wallet operation is running.'
          : 'Could not switch wallets. Existing data was preserved.',
      );
  }
  if (wallets.length < 2) return null;
  return (
    <section aria-label="Wallets on this device">
      <List label="Saved wallets">
        {wallets.map((item) => (
          <ListRow
            key={item.address}
            leading={null}
            trailing={
              item.address === wallet.address ? (
                <Badge>Active</Badge>
              ) : (
                <Button
                  variant={BUTTON_VARIANT.TONAL}
                  disabled={busy}
                  onClick={() => {
                    if (item.address) void select(item.address);
                  }}
                >
                  Use wallet
                </Button>
              )
            }
          >
            <RowCopy
              title={
                item.address === wallet.address
                  ? 'Active wallet'
                  : 'Saved wallet'
              }
              detail={item.address ?? ''}
            />
          </ListRow>
        ))}
      </List>
      {error && (
        <p className="modal-note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
