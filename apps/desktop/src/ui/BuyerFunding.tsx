// Shows the payer used by the local buyer for channel deposits.
import { useId, useState } from 'react';

import { DEVNET } from '@gyblos/config/network';
import { atomicToUsdc } from '@gyblos/node/node-config-price';

import type { BuyerFunding } from '../funding/model';
import { BUTTON_VARIANT } from './constants';
import { CopyField } from './Form';
import { Modal } from './Modal';
import { Button } from './UI';
import { useBuyerFunding } from './useBuyerFunding';

export function BuyerFundingAddress({ funding }: { funding: BuyerFunding }) {
  const addressId = useId();
  const [notice, setNotice] = useState('');
  async function copy() {
    const copied = await window.desktopFunding
      ?.copyAddress(funding.payer)
      .catch(() => false);
    setNotice(
      copied ? 'Address copied.' : 'Could not copy the current buyer address.',
    );
  }
  return (
    <>
      <CopyField
        id={addressId}
        label="Buyer wallet address"
        value={funding.payer}
        actionLabel="Copy address"
        onCopy={() => void copy()}
      />
      <span className="sr-only" role="status">
        {notice}
      </span>
    </>
  );
}

export function AddBuyerFunds({ payer }: { payer?: string }) {
  const { funding, loading, refresh } = useBuyerFunding(payer);
  const [error, setError] = useState('');
  if (!funding)
    return (
      <div className="ui-form">
        <p>
          {loading ? 'Checking the buyer wallet…' : 'Buyer wallet unavailable.'}
        </p>
        <Button disabled={loading} onClick={refresh}>
          Refresh
        </Button>
      </div>
    );
  const devnet = funding.network === DEVNET && funding.faucetAvailable;
  return (
    <div className="ui-form">
      <p>
        {devnet
          ? 'Copy your buyer wallet address, then select USDC and Solana Devnet at the Circle faucet.'
          : 'Check the network before sending USDC to this address.'}
      </p>
      <BuyerFundingAddress funding={funding} />
      {devnet && (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          onClick={() => {
            void window.desktopFunding
              ?.openFaucet(funding.payer)
              .then((ok) =>
                setError(ok ? '' : 'Could not open the devnet faucet.'),
              )
              .catch(() => setError('Could not open the devnet faucet.'));
          }}
        >
          Open Circle faucet ↗
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <small>The seller pays the channel transaction fees in SOL.</small>
    </div>
  );
}

export function fundingAmount(atomic: string) {
  return atomicToUsdc(BigInt(atomic)) + ' USDC';
}

export function WalletBalanceNotice({
  close,
  loading,
  refresh,
}: {
  close(): void;
  loading: boolean;
  refresh(): void;
}) {
  return (
    <Modal title="Buyer wallet balance" close={close}>
      <div className="ui-form">
        <p role="status">
          {loading
            ? 'Checking available USDC…'
            : 'Could not check the buyer wallet balance.'}
        </p>
        <Button disabled={loading} onClick={refresh}>
          Refresh balance
        </Button>
      </div>
    </Modal>
  );
}
