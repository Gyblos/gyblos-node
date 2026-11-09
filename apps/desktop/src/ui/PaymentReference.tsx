// Displays only validated provider references. Copying is available in the detail dialog.
import { useState } from 'react';

import { PAYPAL_PAYMENT_REFERENCE_KIND } from '@gyblos/node/constants';

import type { PaypalPaymentReference } from '../payment-reference-model';
import { CopyField } from './Form';
import { shortReference } from './history-presentation';

export function PaymentReference({
  reference,
}: {
  reference?: PaypalPaymentReference;
}) {
  return reference ? (
    <code className="ui-transaction-reference">
      {shortReference(reference.id)}
    </code>
  ) : (
    <span className="ui-help-text">—</span>
  );
}
export function PaymentReferenceDetails({
  reference,
}: {
  reference?: PaypalPaymentReference;
}) {
  const [notice, setNotice] = useState('');
  if (!reference)
    return (
      <p className="ui-help-text">
        No provider reference was saved for this record.
      </p>
    );
  const label =
    reference.kind === PAYPAL_PAYMENT_REFERENCE_KIND.CAPTURE
      ? 'PayPal transaction ID'
      : 'PayPal authorization ID';
  return (
    <section className="ui-section">
      <CopyField
        id="payment-reference"
        label={label}
        value={reference.id}
        actionLabel={'Copy ' + label}
        onCopy={() => {
          void navigator.clipboard
            .writeText(reference.id)
            .then(() => setNotice('Payment ID copied.'))
            .catch(() =>
              setNotice('Could not copy. Select the ID to copy it manually.'),
            );
        }}
      />
      <span className="sr-only" role="status">
        {notice}
      </span>
    </section>
  );
}
