// Synthetic wallet metadata only; never creates a wallet or exposes a real address.
import { Copy } from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge, Button, Note } from './UI.js';

const DEMO_ADDRESS = 'demo:gyblos-personal-wallet';
export function WalletDetails() {
  const [copyState, setCopyState] = useState('Copy demo address');
  return (
    <section className="wallet-details" aria-label="Wallet details">
      <div className="connection-location">
        <strong>Personal wallet</strong>
        <Badge>Simulation</Badge>
      </div>
      <span className="modal-note">Network: Solana devnet (preview)</span>
      <span className="field-label">Illustrative address</span>
      <div className="wallet-address">
        <code>{DEMO_ADDRESS}</code>
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(DEMO_ADDRESS);
              setCopyState('Copied');
            } catch {
              setCopyState('Copy unavailable');
            }
          }}
        >
          <Copy size={16} />
          {copyState}
        </Button>
      </div>
      <Note>
        This is not a Solana address. No wallet exists and it cannot receive
        funds.
      </Note>
    </section>
  );
}
