import { useState } from 'react';

import {
  atomicToUsdc,
  pricePerMtokToAtomicPerMtok,
  usdcToAtomic,
} from '@gyblos/node/node-config-price';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import { X402_ACTION } from '../x402/constants';
import { Button } from './UI';
import type { X402View } from './useX402';

export function AutoSellerSettings({
  buyer,
  policy,
}: {
  buyer: X402View;
  policy: BuyerApiPolicy;
}) {
  const [enabled, setEnabled] = useState(!!policy.paidAuto);
  const [maximum, setMaximum] = useState(
    atomicToUsdc(BigInt(policy.maxAtomic)),
  );
  const [input, setInput] = useState(
    atomicToUsdc(BigInt(policy.autoPrices?.inputAtomicPerMtok ?? '0')),
  );
  const [output, setOutput] = useState(
    atomicToUsdc(BigInt(policy.autoPrices?.outputAtomicPerMtok ?? '0')),
  );
  const [error, setError] = useState('');
  async function save() {
    let maxAtomic: string;
    let rates = null;
    try {
      maxAtomic = enabled ? String(usdcToAtomic(maximum)) : policy.maxAtomic;
      if (enabled) {
        rates = {
          inputAtomicPerMtok: String(pricePerMtokToAtomicPerMtok(input)),
          outputAtomicPerMtok: String(pricePerMtokToAtomicPerMtok(output)),
        };
        if (
          maxAtomic === '0' ||
          (rates.inputAtomicPerMtok === '0' &&
            rates.outputAtomicPerMtok === '0')
        )
          throw new Error();
      }
    } catch {
      setError(
        'Enter a positive maximum per response and at least one positive rate, with up to six decimal places.',
      );
      return;
    }
    const result = await buyer.run({
      action: X402_ACTION.CONFIGURE_PAID,
      policyId: policy.policyId,
      maxAtomic,
      autoPrices: rates,
    });
    setError(
      result?.error ?? (result?.policy ? '' : 'Could not save Auto settings.'),
    );
  }
  return (
    <details className="ui-form">
      <summary>
        Automatic seller selection ·{' '}
        {policy.paidAuto ? 'Paid offers enabled' : 'Free offers only'}
      </summary>
      <p className="ui-help-text">
        These limits apply to chat, the CLI and API keys on this buyer. Each key
        also keeps its own budget.
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{' '}
        Allow paid offers in Auto
      </label>
      {enabled && (
        <div className="ui-form">
          <label>
            Maximum per response (USDC)
            <input
              className="ui-input"
              inputMode="decimal"
              value={maximum}
              onChange={(event) => setMaximum(event.target.value)}
            />
          </label>
          <label>
            Maximum input price (USDC / 1M tokens)
            <input
              className="ui-input"
              inputMode="decimal"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <label>
            Maximum output price (USDC / 1M tokens)
            <input
              className="ui-input"
              inputMode="decimal"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
            />
          </label>
        </div>
      )}
      <Button
        disabled={
          buyer.busy ||
          buyer.state.summary.blocked ||
          (!enabled && !policy.paidAuto)
        }
        onClick={() => void save()}
      >
        Save Auto settings
      </Button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
