import { useState } from 'react';

import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import { X402_ACTION, x402BudgetInput, x402ShortAmount } from '../x402-model';
import { AmountField } from './AmountField';
import { BUTTON_VARIANT } from './constants';
import { FormActions, FormField } from './Form';
import { Modal } from './Modal';
import { MotionPresence } from './Motion';
import { Button } from './UI';
import type { X402View } from './useX402';

export function RenewalBudget({
  buyer,
  policy,
}: {
  buyer: X402View;
  policy: BuyerApiPolicy;
}) {
  const current = policy.renewalBudgetAtomic;
  const [editing, setEditing] = useState(false);
  const format = (value: bigint) => x402ShortAmount(String(value), policy);
  return (
    <section className="ui-section" aria-label="Channel renewal">
      <div className="preview-settings-rows">
        <div>
          <span>
            Automatic channel renewal
            <small className="ui-help-text">
              {current
                ? 'Enabled · ' + format(BigInt(current)) + ' USDC total budget'
                : 'Off · Approve a budget to keep agents running when a channel fills up.'}
            </small>
          </span>
          <Button disabled={buyer.busy} onClick={() => setEditing(true)}>
            {current ? 'Manage budget' : 'Set budget'}
          </Button>
        </div>
      </div>
      <MotionPresence>
        {editing && (
          <RenewalDialog
            buyer={buyer}
            policy={policy}
            close={() => setEditing(false)}
          />
        )}
      </MotionPresence>
    </section>
  );
}

function RenewalDialog({
  buyer,
  policy,
  close,
}: {
  buyer: X402View;
  policy: BuyerApiPolicy;
  close(): void;
}) {
  const current = policy.renewalBudgetAtomic;
  const [amount, setAmount] = useState(
    current ? x402ShortAmount(current, policy) : '',
  );
  const [error, setError] = useState('');
  const format = (value: bigint) => x402ShortAmount(String(value), policy);
  const parse = (value: string) => {
    try {
      return BigInt(x402BudgetInput(value, policy));
    } catch {
      return null;
    }
  };
  const minimum = BigInt(policy.depositAtomic!);
  const atomic = parse(amount);
  const valid = atomic !== null && atomic >= minimum;
  const save = (value: string | null) =>
    saveRenewal(buyer, policy, value, close, setError);
  return (
    <Modal
      title="Automatic channel renewal"
      close={() => {
        if (!buyer.busy) close();
      }}
    >
      <div className="ui-form">
        <p>
          Let the buyer replace a full channel with the same seller at the same
          terms. Chat and your API keys share this budget.
        </p>
        <FormField label="Total renewal budget" htmlFor="renewal-budget">
          <AmountField
            compact
            id="renewal-budget"
            unit="USDC"
            value={amount}
            onChange={setAmount}
            placeholder="0"
            parse={parse}
            format={format}
            step={minimum}
            invalid={!!amount && !valid}
            disabled={buyer.busy}
            describedBy="renewal-help"
          />
        </FormField>
        <p id="renewal-help" className="ui-help-text">
          Minimum {format(minimum)} USDC for a channel deposit. The budget has
          no automatic reset. Each API key keeps its own limit.
        </p>
        {error && <p role="status">{error}</p>}
        <FormActions align="start">
          <Button
            disabled={!valid || buyer.busy}
            variant={BUTTON_VARIANT.PRIMARY}
            onClick={() => {
              if (valid) void save(String(atomic));
            }}
          >
            {current ? 'Save budget' : 'Authorize renewal'}
          </Button>
          {current && (
            <Button disabled={buyer.busy} onClick={() => void save(null)}>
              Turn off renewal
            </Button>
          )}
          <Button disabled={buyer.busy} onClick={() => close()}>
            Cancel
          </Button>
        </FormActions>
      </div>
    </Modal>
  );
}

async function saveRenewal(
  buyer: X402View,
  policy: BuyerApiPolicy,
  limitAtomic: string | null,
  close: () => void,
  setError: (message: string) => void,
) {
  const result = await buyer.run({
    action: X402_ACTION.CONFIGURE_RENEWAL,
    policyId: policy.policyId,
    limitAtomic,
  });
  if (
    result?.policy &&
    !result.error &&
    (result.policy.renewalBudgetAtomic ?? null) === limitAtomic
  )
    close();
  else
    setError(
      result?.error ?? 'Could not verify the renewal budget. Check Payments.',
    );
}
