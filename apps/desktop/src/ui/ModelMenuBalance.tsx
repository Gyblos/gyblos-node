import { Plus, Wallet } from '@phosphor-icons/react';

import { Button } from './UI';

export function ModelMenuBalance({
  amount,
  status,
  onAdd,
}: {
  amount?: string;
  status?: string;
  onAdd(): void;
}) {
  return (
    <p className="pk-balance-line">
      <Wallet size={14} aria-hidden="true" />
      <span>Balance</span>
      <strong
        title={amount && 'Last checked balance: ' + amount}
        data-unavailable={amount == null || undefined}
      >
        {amount ?? status}
      </strong>
      <Button className="pk-balance-add" onClick={onAdd}>
        <Plus size={12} weight="bold" aria-hidden="true" />
        Add funds
      </Button>
    </p>
  );
}
