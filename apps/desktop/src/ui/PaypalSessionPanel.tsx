// Manages the existing shared PayPal session from Payments; all operations retain controller guards.
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import {
  paypalDollars as dollars,
  paypalPaymentSummary,
} from '../paypal-model';
import { BUTTON_VARIANT } from './constants';
import {
  CheckStatus,
  NewSessionTerms,
  PaypalCheckoutActions,
  StartPaypalSession,
  VoidCheckAction,
} from './PaypalCheckoutActions';
import { Badge, Button, StatCard } from './UI';
import type { PaypalSessionView } from './usePaypalSession';

type SessionProps = PaypalSessionView;
type Snapshot = PaypalSessionView['state'];

function uncertain(state: Snapshot) {
  const phase = state.status?.phase;
  return (
    phase === PAYPAL_SESSION_STATUS.BLOCKED ||
    phase === PAYPAL_SESSION_PHASE.CREATING ||
    phase === PAYPAL_SESSION_PHASE.REVIEW ||
    phase === PAYPAL_SESSION_PHASE.AUTHORIZING ||
    phase === PAYPAL_SESSION_PHASE.CAPTURING ||
    phase === PAYPAL_SESSION_PHASE.VOIDING
  );
}

function NewSessionActions(props: SessionProps) {
  const { state } = props;
  return (
    <div className="payment-new-session">
      <h3>
        {state.status?.phase === PAYPAL_SESSION_STATUS.READY
          ? 'Choose a session limit'
          : 'Start another session'}
      </h3>
      <NewSessionTerms state={state} limitCents={props.limitCents} />
      <div className="payment-start-actions">
        <StartPaypalSession {...props} />
      </div>
    </div>
  );
}

function SessionActions(props: SessionProps) {
  const { chat, state } = props;
  const phase = state.statusFresh ? state.status?.phase : undefined;
  const canCreate =
    phase === PAYPAL_SESSION_STATUS.READY ||
    phase === PAYPAL_SESSION_PHASE.COMPLETED ||
    phase === PAYPAL_SESSION_PHASE.VOIDED ||
    phase === PAYPAL_SESSION_PHASE.CANCELLED;
  return (
    <div className="paypal-session-actions">
      {!state.statusFresh && (
        <Button
          disabled={state.busy}
          onClick={() => {
            void chat.refresh();
          }}
        >
          Check session status
        </Button>
      )}
      {canCreate && <NewSessionActions {...props} />}
      {phase === PAYPAL_SESSION_PHASE.CREATED && (
        <PaypalCheckoutActions chat={chat} state={state} />
      )}
      {phase === PAYPAL_SESSION_PHASE.ACTIVE && (
        <Button
          variant={BUTTON_VARIANT.SECONDARY}
          disabled={state.busy || !!state.pendingMessageId}
          onClick={() => {
            void chat.finish();
          }}
        >
          End session
        </Button>
      )}
      {phase === PAYPAL_SESSION_PHASE.VOIDING && (
        <VoidCheckAction chat={chat} state={state} />
      )}
      {phase === PAYPAL_SESSION_PHASE.EXECUTING &&
        (state.status?.spentCents ?? 0) > 0 && (
          <Button
            disabled={state.busy}
            onClick={() => {
              void chat.reviewAndSettle();
            }}
          >
            Review uncertain attempt
          </Button>
        )}
      {state.pendingMessageId && (
        <Button
          disabled={state.busy}
          onClick={() => {
            void chat.retryAcknowledgement();
          }}
        >
          Retry response acknowledgment
        </Button>
      )}
      {state.statusFresh &&
        (uncertain(state) ||
          phase === PAYPAL_SESSION_PHASE.EXECUTING ||
          (phase === PAYPAL_SESSION_PHASE.MESSAGE_PENDING &&
            !state.pendingMessageId)) && (
          <CheckStatus chat={chat} state={state} />
        )}
    </div>
  );
}

function SessionMessages({ state }: { state: Snapshot }) {
  const phase = state.statusFresh ? state.status?.phase : undefined;
  return (
    <>
      {!state.statusFresh && (
        <p>
          The session status could not be checked. Check it before continuing.
        </p>
      )}
      {phase === PAYPAL_SESSION_PHASE.VOIDED && (
        <p>
          Sandbox authorization voided. Recorded Gyblos usage was{' '}
          {state.status ? dollars(state.status.spentCents) : 'unavailable'}.
        </p>
      )}
      {phase === PAYPAL_SESSION_PHASE.ACTIVE && state.status?.expired && (
        <p>Session expired for new messages. Close it to settle.</p>
      )}
      {phase === PAYPAL_SESSION_PHASE.ACTIVE &&
        state.status?.remainingAttempts === 0 && (
          <p>The attempt limit was reached. Close and settle the session.</p>
        )}
      {phase === PAYPAL_SESSION_PHASE.CREATED &&
        !state.status?.approvalLinkAvailable && (
          <p>
            This checkout link is no longer available. If already approved,
            check the approval; otherwise abandon this order and create a new
            one. Do not use a checkout tab opened before restarting Gyblos. If
            Gyblos was restarted, settle the restored session and create a new
            one before connecting agents.
          </p>
        )}
      {state.statusFresh && uncertain(state) && (
        <p>
          Session needs external review and the usage shown may be uncertain.
          Refreshing local status does not contact PayPal. Do not retry payment
          or remove its record.
        </p>
      )}
      {phase === PAYPAL_SESSION_PHASE.EXECUTING && (
        <p>
          Inference is running or needs review if it failed. Do not retry
          payment or remove its record.
        </p>
      )}
      {phase === PAYPAL_SESSION_PHASE.MESSAGE_PENDING &&
        !state.pendingMessageId && (
          <p>
            A prior response awaits confirmation and the session needs review.
          </p>
        )}
    </>
  );
}

function SessionAmounts({
  summary,
}: {
  summary: ReturnType<typeof paypalPaymentSummary>;
}) {
  return (
    <>
      {' '}
      {summary.limitCents !== null && (
        <div className="payment-session-stats">
          <StatCard
            label="Session limit"
            value={dollars(summary.limitCents)}
            detail="Maximum for this session"
          />
          <StatCard
            label={
              summary.capturedCents !== null
                ? 'Payment captured'
                : 'Recorded usage'
            }
            value={dollars(summary.capturedCents ?? summary.usedCents ?? 0)}
            detail={
              summary.capturedCents !== null
                ? 'Confirmed by PayPal'
                : 'Not yet a confirmed payment'
            }
          />
          {summary.remainingCents !== null && (
            <StatCard
              label="Remaining limit"
              value={dollars(summary.remainingCents)}
              detail="Available within this session"
            />
          )}
        </div>
      )}
    </>
  );
}

export function PaypalSessionPanel({
  session,
  onChat,
}: {
  session: PaypalSessionView;
  onChat: () => void;
}) {
  const { state } = session;
  const summary = paypalPaymentSummary(
    state.status,
    state.statusFresh,
    state.busy,
  );
  return (
    <section
      className="payment-session ui-settings-group"
      aria-label="PayPal Sandbox session"
    >
      <header className="payment-session-heading">
        <div>
          <h2>PayPal session</h2>
          <p>
            Approve a limit once. Pay for recorded usage when you end the
            session.
          </p>
        </div>
        <Badge>Sandbox · test funds</Badge>
      </header>
      <div className="payment-session-state" role="status">
        <span className="payment-state-dot" aria-hidden="true" />
        <strong>{summary.label}</strong>
        {summary.rateCents !== null && (
          <span className="payment-session-rate">
            {dollars(summary.rateCents)} per inference
          </span>
        )}
      </div>
      <SessionAmounts summary={summary} />
      <SessionMessages state={state} />
      <SessionActions {...session} />
      {state.notice && (
        <p className="chat-notice" role="status">
          {state.notice}
        </p>
      )}
      <div className="payment-session-footer">
        <span>Chat and connected agents share this session.</span>
        <Button variant={BUTTON_VARIANT.TONAL} onClick={onChat}>
          Go to chat
        </Button>
      </div>
    </section>
  );
}
