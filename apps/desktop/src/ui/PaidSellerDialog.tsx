// The first paid message opens the channel after the selected seller and maximum are confirmed.
import { useState } from 'react';

import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';
import { atomicToUsdc, usdcToAtomic } from '@gyblos/node/node-config-price';

import { paidSellerLimitNotice, X402_ACTION } from '../x402-model';
import { BUTTON_VARIANT } from './constants';
import { FormField, FormInput } from './Form';
import { Modal } from './Modal';
import { usdPerMtok } from './model-price';
import type { CatalogModel } from './model-types';
import { Button } from './UI';
import type { X402View } from './useX402';

export function PaidSellerDialog({
  model,
  buyer,
  close,
  confirm,
}: {
  model: CatalogModel;
  buyer: X402View;
  close(): void;
  confirm(policyId: string): void;
}) {
  const { policy } = buyer.state;
  const [maximum, setMaximum] = useState(() =>
    policy && policy.maxAtomic !== '0'
      ? atomicToUsdc(BigInt(policy.maxAtomic))
      : '',
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const deposit =
    policy?.depositAtomic ?? BUYER_SESSION_DEFAULT_POLICY.depositAtomic;
  const minutes =
    (policy?.lifetimeMs ?? BUYER_SESSION_DEFAULT_POLICY.lifetimeMs) / 60000;
  async function select() {
    let maxAtomic: string;
    try {
      maxAtomic = String(usdcToAtomic(maximum));
      if (maxAtomic === '0') throw new Error();
    } catch {
      setError('Enter a positive USDC maximum with up to six decimal places.');
      return;
    }
    setSaving(true);
    try {
      const result =
        policy?.maxAtomic === maxAtomic &&
        policy.depositAtomic &&
        policy.lifetimeMs
          ? buyer.state
          : await buyer.run({
              action: X402_ACTION.CONFIGURE_PAID,
              maxAtomic,
              ...(policy ? { policyId: policy.policyId } : {}),
            });
      if (!result?.policy || result.error) {
        setError(
          result?.error ?? 'Could not apply the spending maximum. Try again.',
        );
        return;
      }
      const notice = paidSellerLimitNotice(
        result.policy,
        result.summary,
        model.name,
      );
      if (notice) setError(notice);
      else confirm(result.policy.policyId);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="Confirm seller"
      close={() => {
        if (!saving) close();
      }}
    >
      <form
        className="ui-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!buyer.busy && !saving) void select();
        }}
      >
        <div>
          <strong>{model.name}</strong>
          <p>{model.family}</p>
        </div>
        <FormField
          htmlFor="paid-response-maximum"
          label="Maximum per response (USDC)"
        >
          <FormInput
            id="paid-response-maximum"
            inputMode="decimal"
            placeholder="0.00"
            value={maximum}
            onChange={(event) => {
              setMaximum(event.target.value);
              setError('');
            }}
          />
        </FormField>
        <p>
          Your first message opens a channel with a{' '}
          {atomicToUsdc(BigInt(deposit))} USDC deposit for {minutes} minutes.
        </p>
        <details>
          <summary>Seller rates</summary>
          <p>
            {usdPerMtok(model.input)} input · {usdPerMtok(model.output)} output
            per 1M tokens
          </p>
        </details>
        {error && <p role="alert">{error}</p>}
        <Button
          type="submit"
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={!maximum || saving || buyer.busy}
        >
          {saving ? 'Saving…' : 'Confirm seller'}
        </Button>
      </form>
    </Modal>
  );
}
