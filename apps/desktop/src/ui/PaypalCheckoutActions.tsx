// Presents checkout actions without holding payment credentials or provider URLs.
import { PAYPAL_SANDBOX_LIMIT_OPTIONS } from '@gyblos/config/constants';

import type { PaypalChatController } from '../paypal-chat';
import {
  paypalAmountsAvailable,
  paypalDollars,
  paypalNewSessionTerms,
  paypalUsageSummary,
} from '../paypal-model';
import { BUTTON_VARIANT } from './constants';
import { Button } from './UI';

export function SessionLimitSelector({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="chat-payment-options" aria-label="Session limit">
      <legend>Limit</legend>
      {PAYPAL_SANDBOX_LIMIT_OPTIONS.map((limit) => (
        <label className="chat-payment-option" key={limit}>
          <input
            type="radio"
            name="paypal-session-limit"
            checked={value === limit}
            disabled={disabled}
            onChange={() => onChange(limit)}
          />
          <span>{paypalDollars(limit)}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function StartPaypalSession({
  chat,
  state,
  limitCents,
  setLimitCents,
}: {
  chat: PaypalChatController;
  state: ReturnType<PaypalChatController['getSnapshot']>;
  limitCents: number;
  setLimitCents: (value: number) => void;
}) {
  return (
    <>
      <SessionLimitSelector
        value={limitCents}
        disabled={state.busy}
        onChange={setLimitCents}
      />
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={state.busy}
        onClick={() => {
          void chat.startCheckout(limitCents);
        }}
      >
        Continue with PayPal
      </Button>
    </>
  );
}

export function NewSessionTerms({
  state,
  limitCents,
}: {
  state: ReturnType<PaypalChatController['getSnapshot']>;
  limitCents: number;
}) {
  const terms = paypalNewSessionTerms(state.status, state.statusFresh);
  if (!terms) return null;
  return (
    <span className="paypal-session-usage">
      Up to {paypalDollars(limitCents)} authorized ·{' '}
      {paypalDollars(terms.messageCents)} per inference; only usage is captured.
    </span>
  );
}

export function SessionUsage({
  state,
}: {
  state: ReturnType<PaypalChatController['getSnapshot']>;
}) {
  const status = state.status;
  if (!state.statusFresh || !status || !paypalAmountsAvailable(status))
    return null;
  const previous = paypalNewSessionTerms(status, true) !== null;
  if (previous) return null;
  return (
    <span className="paypal-session-usage">
      <strong>
        {paypalUsageSummary(status.spentCents, status.limitCents)}
      </strong>
      {` · ${paypalDollars(status.messageCents)} per inference`}
    </span>
  );
}

export function VoidCheckAction({
  chat,
  state,
}: {
  chat: PaypalChatController;
  state: ReturnType<PaypalChatController['getSnapshot']>;
}) {
  return (
    <Button
      disabled={state.busy}
      onClick={() => {
        void chat.checkVoidedAuthorization();
      }}
    >
      Check with PayPal
    </Button>
  );
}

export function CheckStatus({
  chat,
  state,
}: {
  chat: PaypalChatController;
  state: ReturnType<PaypalChatController['getSnapshot']>;
}) {
  return (
    <Button
      disabled={state.busy}
      onClick={() => {
        void chat.refresh();
      }}
    >
      Refresh local status
    </Button>
  );
}

export function PaypalCheckoutActions({
  chat,
  state,
}: {
  chat: PaypalChatController;
  state: ReturnType<PaypalChatController['getSnapshot']>;
}) {
  return (
    <>
      <p>
        Approve in PayPal and Gyblos checks the return automatically. If the
        session does not start, check the approval below.
      </p>
      <Button
        disabled={state.busy || !state.status?.approvalLinkAvailable}
        onClick={() => {
          void chat.openApproval();
        }}
      >
        Open PayPal Sandbox
      </Button>
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={state.busy}
        onClick={() => {
          void chat.approve();
        }}
      >
        Check approval and start session
      </Button>
      <Button
        disabled={state.busy}
        onClick={() => {
          void chat.abandon();
        }}
      >
        Abandon checkout in Gyblos
      </Button>
    </>
  );
}
