// End-user top-up form; the payment boundary remains closed until a service exists.
import { Archive } from '@phosphor-icons/react';
import { useState } from 'react';

import { prepareTopUp, TOP_UP_STATUS, type TopUpStatus } from './add-funds';
import { BUTTON_VARIANT, TOP_UP_AMOUNTS } from './constants';
import { FormField, FormInput } from './Form';
import { Button } from './UI';
import { useDesktopWallet } from './WalletState';

const messages = {
  [TOP_UP_STATUS.INVALID_AMOUNT]:
    'Enter an amount greater than zero, with up to two decimals.',
  [TOP_UP_STATUS.WALLET_UNAVAILABLE]:
    'Your wallet is not ready. Try again in a moment.',
  [TOP_UP_STATUS.BACKUP_REQUIRED]:
    'Back up your wallet and verify the file before adding funds.',
  [TOP_UP_STATUS.PAYMENT_UNAVAILABLE]:
    'Payments are not available yet. Please try again later.',
};

export function AddFunds({ onBackup }: { onBackup: () => void }) {
  const wallet = useDesktopWallet();
  const [amount, setAmount] = useState<string>(TOP_UP_AMOUNTS[0]);
  const [status, setStatus] = useState<TopUpStatus | null>(null);
  function updateAmount(value: string) {
    setAmount(value);
    setStatus(null);
  }
  return (
    <form
      className="wallet-details"
      onSubmit={(event) => {
        event.preventDefault();
        setStatus(prepareTopUp(amount, wallet));
      }}
    >
      <FormField htmlFor="top-up-amount" label="Amount (USDC)">
        <FormInput
          id="top-up-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => updateAmount(event.target.value)}
        />
      </FormField>
      <div
        className="ui-segmented top-up-amounts"
        role="group"
        aria-label="Suggested amounts"
      >
        {TOP_UP_AMOUNTS.map((value) => (
          <Button
            key={value}
            aria-pressed={amount === value}
            onClick={() => updateAmount(value)}
          >
            {value} USDC
          </Button>
        ))}
      </div>
      <p className="modal-note">
        Use your balance for paid models and connected tools.
      </p>
      {status && (
        <p className="modal-note" role="alert">
          {messages[status]}
        </p>
      )}
      {status === TOP_UP_STATUS.BACKUP_REQUIRED ? (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          className="wide"
          onClick={onBackup}
        >
          <Archive size={16} aria-hidden="true" /> Back up wallet
        </Button>
      ) : (
        <Button variant={BUTTON_VARIANT.PRIMARY} className="wide" type="submit">
          Continue
        </Button>
      )}
    </form>
  );
}
