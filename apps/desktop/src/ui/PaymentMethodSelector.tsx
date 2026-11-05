// Presents payment choices without creating sessions or accessing wallet state.
import { CurrencyCircleDollar, PaypalLogo } from '@phosphor-icons/react';

import { PAYMENT_METHOD, type PaymentMethod } from '../paypal-model';
import { ChoiceCard } from './UI';

export function PaymentMethodSelector({
  value,
  onChange,
  name,
  label = 'Payment method',
}: {
  value: PaymentMethod;
  onChange: (value: PaymentMethod) => void;
  name: string;
  label?: string;
}) {
  return (
    <div className="ui-choice-grid" role="radiogroup" aria-label={label}>
      <ChoiceCard
        name={name}
        title="USDC wallet"
        description="Preview"
        leading={<CurrencyCircleDollar size={24} />}
        selected={value === PAYMENT_METHOD.USDC}
        onSelect={() => onChange(PAYMENT_METHOD.USDC)}
      />
      <ChoiceCard
        name={name}
        title="PayPal Sandbox"
        description="Test funds"
        leading={<PaypalLogo size={24} />}
        selected={value === PAYMENT_METHOD.PAYPAL}
        onSelect={() => onChange(PAYMENT_METHOD.PAYPAL)}
      />
    </div>
  );
}
