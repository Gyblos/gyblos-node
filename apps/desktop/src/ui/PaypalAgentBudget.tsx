// Shared form and amount primitives expose the host-enforced lifetime API key budget.
import { useState } from 'react';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';

import {
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentLimitCents,
  type PaypalAgentResult,
} from '../paypal-agent-model';
import { paypalDollars } from '../paypal-model';
import { BUTTON_VARIANT } from './constants';
import { FormActions, FormField, FormInput } from './Form';
import { Button } from './UI';

export function CreatePaypalAgentBudget({
  availableCents,
  disabled,
  create,
}: {
  availableCents: number;
  disabled: boolean;
  create: (limitCents: number) => void;
}) {
  const [draft, setDraft] = useState(() =>
    String(
      Math.min(PAYPAL_SANDBOX.limitCents, availableCents) /
        PAYPAL_SANDBOX.centsPerDollar,
    ),
  );
  const limit = paypalAgentLimitCents(draft);
  const valid = limit !== null && limit <= availableCents;
  return (
    <div className="ui-form ui-form--limited">
      <FormField label="API key spend limit · USD" htmlFor="api-key-limit">
        <FormInput
          id="api-key-limit"
          type="number"
          min={PAYPAL_SANDBOX.messagePrice}
          step={PAYPAL_SANDBOX.messagePrice}
          max={availableCents / PAYPAL_SANDBOX.centsPerDollar}
          value={draft}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(event) => setDraft(event.target.value)}
        />
      </FormField>
      <p className="ui-help-text">
        Total for this key, shared by all connected tools. Chat uses the session
        budget separately. No automatic reset.
      </p>
      {!valid && (
        <p className="ui-help-text" role="alert">
          Choose a multiple of {paypalDollars(PAYPAL_SANDBOX.messageCents)}, up
          to {paypalDollars(availableCents)} remaining in the session.
        </p>
      )}
      <FormActions align="start">
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={disabled || !valid}
          onClick={() => {
            if (valid && limit !== null) create(limit);
          }}
        >
          Create API connection
        </Button>
      </FormActions>
    </div>
  );
}
export function PaypalAgentBudget({
  connection,
  busy,
}: {
  connection: NonNullable<PaypalAgentResult['connection']>;
  busy: boolean;
}) {
  return (
    <section className="ui-section" aria-label="API key spend limit">
      <dl className="ui-stats">
        <div>
          <dt>Key limit</dt>
          <dd>{paypalDollars(connection.keyLimitCents)}</dd>
        </div>
        <div>
          <dt>Key usage</dt>
          <dd>
            {busy ? 'Checking…' : paypalDollars(connection.keySpentCents)}
          </dd>
        </div>
        <div>
          <dt>Key remaining</dt>
          <dd>
            {busy ||
            (connection.usageUncertain &&
              connection.usageState !==
                PAYPAL_AGENT_USAGE_STATE.KEY_LIMIT_REACHED)
              ? 'Unavailable'
              : paypalDollars(
                  connection.keyLimitCents - connection.keySpentCents,
                )}
          </dd>
        </div>
      </dl>
      <p className="ui-help-text">
        All connected tools share this cap. The approved session limit also
        applies. To change it, disconnect and create a new key.
      </p>
    </section>
  );
}
