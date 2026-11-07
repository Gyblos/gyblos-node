// Presents freshly checked shared amounts; never infers client identity or payment success.
import {
  DESKTOP_PAYPAL_AGENT,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentConnectionLabel,
  type PaypalAgentResult,
} from '../paypal-agent-model';
import { paypalDollars, type PaypalResult } from '../paypal-model';
import { Button } from './UI';

type Props = {
  connection: PaypalAgentResult['connection'];
  busy: boolean;
  statusUnavailable: boolean;
  sessionReady: boolean;
  sessionStatus: PaypalResult['status'];
  sessionFresh: boolean;
  onPayments: () => void;
};

export function connectionUsageMessage(
  state: NonNullable<Props['connection']>['usageState'],
) {
  switch (state) {
    case PAYPAL_AGENT_USAGE_STATE.BUSY:
      return 'An inference or session operation is in progress; usage may change.';
    case PAYPAL_AGENT_USAGE_STATE.CHAT_PENDING:
      return 'A chat response awaits confirmation. Finish it in Payments.';
    case PAYPAL_AGENT_USAGE_STATE.EXPIRED:
      return 'The session expired. Close and settle it in Payments.';
    case PAYPAL_AGENT_USAGE_STATE.ATTEMPTS_EXHAUSTED:
      return 'The attempt limit was reached. Review Payments.';
    case PAYPAL_AGENT_USAGE_STATE.LIMIT_REACHED:
      return 'The approved spending limit was reached. Review Payments.';
    case PAYPAL_AGENT_USAGE_STATE.DISCONNECTING:
      return 'Disconnecting. An inference already started can finish and count.';
    case PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED:
      return 'Disconnection could not be confirmed. Retry or review Payments.';
    default:
      return 'The session needs review. Check Payments.';
  }
}

function SessionAmounts({
  connection,
  busy,
  statusUnavailable,
  sessionReady,
  sessionStatus,
  sessionFresh,
}: Props) {
  const usage =
    !busy && !statusUnavailable && connection && !connection.usageUncertain
      ? connection
      : !busy &&
          !statusUnavailable &&
          !connection &&
          sessionReady &&
          sessionFresh
        ? sessionStatus
        : null;
  if (!usage)
    return (
      <p className="ui-help-text">
        {connection?.usageUncertain
          ? connectionUsageMessage(connection.usageState)
          : 'Open Payments to check or prepare your session.'}
      </p>
    );
  return (
    <dl className="ui-detail-list">
      <div>
        <dt>Limit</dt>
        <dd>{paypalDollars(usage.limitCents)}</dd>
      </div>
      <div>
        <dt>Recorded</dt>
        <dd>{paypalDollars(usage.spentCents)}</dd>
      </div>
      <div>
        <dt>Remaining</dt>
        <dd>{paypalDollars(usage.limitCents - usage.spentCents)}</dd>
      </div>
    </dl>
  );
}

export function ConnectionContext(props: Props) {
  const { connection, busy, statusUnavailable, onPayments } = props;
  const ready =
    !!connection && !busy && !statusUnavailable && !connection.usageUncertain;
  return (
    <>
      <section className="ui-context-section">
        <h3>{connection || statusUnavailable || busy ? 'Status' : 'Model'}</h3>
        {connection || statusUnavailable || busy ? (
          <>
            <strong className="ui-status-line" data-ready={ready}>
              {ready
                ? 'Local API ready'
                : paypalAgentConnectionLabel(
                    connection,
                    busy,
                    statusUnavailable,
                  )}
            </strong>
            <p className="ui-help-text">
              {ready
                ? 'Ready for compatible apps.'
                : statusUnavailable
                  ? 'A prior connection may still be active.'
                  : 'Check Payments before starting requests.'}
            </p>
          </>
        ) : (
          <>
            <strong className="ui-monospace">
              {DESKTOP_PAYPAL_AGENT.MODEL}
            </strong>
            <p className="ui-help-text">Local · Ollama</p>
          </>
        )}
      </section>
      <section className="ui-context-section">
        <h3>Access</h3>
        <strong>This computer</strong>
        <p className="ui-help-text">Keep Gyblos open while your tool runs.</p>
      </section>
      <section className="ui-context-section">
        <h3>Payment session</h3>
        <strong>PayPal Sandbox</strong>
        <p className="ui-help-text">Test funds · Shared session</p>
        <SessionAmounts {...props} />
        <Button onClick={onPayments}>View payments</Button>
      </section>
    </>
  );
}
