// Selects the current chat payment method without initiating payment operations.
import { Check, CurrencyCircleDollar, PaypalLogo } from '@phosphor-icons/react';

import { PAYMENT_METHOD, type PaymentMethod } from '../paypal-model';
import { Dropdown } from './Dropdown';
import { MenuItem } from './UI';

function methodLabel(method: PaymentMethod) {
  return method === PAYMENT_METHOD.USDC ? 'USDC' : 'PayPal Sandbox';
}
function PaymentIcon({ method }: { method: PaymentMethod }) {
  return method === PAYMENT_METHOD.USDC ? (
    <CurrencyCircleDollar size={16} aria-hidden="true" />
  ) : (
    <PaypalLogo size={16} aria-hidden="true" />
  );
}

type PaymentSelection = {
  value: PaymentMethod;
  locked: boolean;
  onChange: (value: PaymentMethod) => void;
};
type Props = PaymentSelection & {
  onManage: () => void;
};
export function ChatPaymentSelector({
  value,
  locked,
  onChange,
  onManage,
}: Props) {
  return (
    <Dropdown
      label="Choose payment method"
      searchLabel="Search payment methods"
      iconOnly
      trigger={<PaymentIcon method={value} />}
    >
      {(close, query) => {
        const options = [PAYMENT_METHOD.USDC, PAYMENT_METHOD.PAYPAL].filter(
          (method) =>
            methodLabel(method)
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        );
        return (
          <>
            {options.map((method) => (
              <MenuItem
                key={method}
                role="menuitemradio"
                checked={value === method}
                disabled={locked && value !== method}
                label={methodLabel(method)}
                detail={
                  method === PAYMENT_METHOD.USDC
                    ? 'Preview · simulated responses'
                    : 'Test funds · session limit'
                }
                leading={<PaymentIcon method={method} />}
                trailing={value === method && <Check size={16} />}
                onClick={() => {
                  close();
                  if (!locked && method !== value) onChange(method);
                }}
              />
            ))}
            {!options.length && (
              <p className="dropdown-note" role="status">
                No payment methods found
              </p>
            )}
            <MenuItem
              footer
              label="Manage payments"
              onClick={() => {
                close();
                onManage();
              }}
            />
          </>
        );
      }}
    </Dropdown>
  );
}
