// Guides local agent connections to the existing shared PayPal Sandbox session.
import { useState } from 'react';

import {
  PAYPAL_AGENT_CLIENT,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentConnectionLabel,
  type PaypalAgentClient,
  type PaypalAgentResult,
  type PaypalAgentUsageState,
} from '../paypal-agent-model';
import { paypalDollars } from '../paypal-model';
import { PAYPAL_AGENT_CARDS } from './constants';
import { usePaypalAgentConnection } from './paypal-agent-connection-hook';
import { PaypalAgentSetup } from './PaypalAgentSetup';
import { ServiceLogo } from './ServiceLogo';
import { Badge, ChoiceCard } from './UI';

function usageMessage(state: PaypalAgentUsageState) {
  switch (state) {
    case PAYPAL_AGENT_USAGE_STATE.BUSY:
      return 'An inference or session operation is in progress; usage may change.';
    case PAYPAL_AGENT_USAGE_STATE.CHAT_PENDING:
      return 'A chat response awaits confirmation. Finish it in PayPal Chat.';
    case PAYPAL_AGENT_USAGE_STATE.EXPIRED:
      return 'The session expired. Close and settle it in PayPal Chat.';
    case PAYPAL_AGENT_USAGE_STATE.ATTEMPTS_EXHAUSTED:
      return 'The attempt limit was reached. Close and settle the session in PayPal Chat.';
    case PAYPAL_AGENT_USAGE_STATE.LIMIT_REACHED:
      return 'The approved spending limit was reached. Close and settle it in PayPal Chat.';
    case PAYPAL_AGENT_USAGE_STATE.DISCONNECTING:
      return 'Disconnecting. An inference already started can finish and count.';
    case PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED:
      return 'Disconnection could not be confirmed. Retry or review the session in PayPal Chat.';
    default:
      return 'The session needs review. Check PayPal Chat.';
  }
}
function AgentUsage({
  connection,
  statusUnavailable,
}: {
  connection: PaypalAgentResult['connection'];
  statusUnavailable: boolean;
}) {
  return (
    <>
      {statusUnavailable && (
        <p role="status">
          The connection status cannot be checked. A prior connection may still
          be active.
        </p>
      )}
      {connection &&
        (statusUnavailable ? (
          <p>Session usage and the remaining amount cannot be verified.</p>
        ) : connection.usageUncertain ? (
          <p>{usageMessage(connection.usageState)}</p>
        ) : (
          <p>
            {paypalDollars(connection.limitCents - connection.spentCents)}{' '}
            remaining · {paypalDollars(connection.spentCents)} used of{' '}
            {paypalDollars(connection.limitCents)}
          </p>
        ))}
    </>
  );
}
function ClientSelector({
  client,
  select,
}: {
  client: PaypalAgentClient;
  select: (client: PaypalAgentClient) => void;
}) {
  return (
    <div
      className="ui-choice-grid"
      role="radiogroup"
      aria-label="Choose an agent"
    >
      {PAYPAL_AGENT_CARDS.map((item) => (
        <ChoiceCard
          key={item.client}
          name="paypal-agent-client"
          title={item.client}
          description={item.detail}
          leading={<ServiceLogo service={item.client} />}
          selected={client === item.client}
          onSelect={() => select(item.client)}
          stacked
        />
      ))}
    </div>
  );
}
function SandboxUsageDetails() {
  return (
    <section
      className="ui-section ui-help-text"
      aria-label="PayPal Sandbox usage"
    >
      <h3 className="ui-subheading">PayPal Sandbox usage</h3>
      <p>
        Each completed inference uses the session's rate, even if its response
        is not delivered. Check the rate in PayPal Chat. One instruction may
        need several inferences.
      </p>
      <p>
        An inference already started can finish after disconnecting. Identical
        requests without an operation key may be rejected to prevent a repeated
        charge. Settle the session in Chat when finished.
      </p>
    </section>
  );
}
export function PaypalAgentConnection({
  onlyConnected = false,
}: {
  onlyConnected?: boolean;
}) {
  const { connection, busy, notice, statusUnavailable, run, copy } =
    usePaypalAgentConnection();
  const [client, setClient] = useState<PaypalAgentClient>(
    PAYPAL_AGENT_CLIENT.OPENCODE,
  );
  if (onlyConnected && !connection && !statusUnavailable) return null;
  return (
    <section
      className="paypal-agent-page"
      aria-label="Agent sandbox connection"
    >
      <header className="paypal-agent-header">
        <div>
          <h2>Connect your agent</h2>
          <p>Use Gyblos inference in the tools you already work with.</p>
        </div>
        <Badge>PayPal Sandbox</Badge>
      </header>
      <div className="paypal-agent-session">
        <div className="paypal-agent-session-copy">
          <span
            className="paypal-agent-status-dot"
            data-connected={
              !!connection &&
              !connection.usageUncertain &&
              !statusUnavailable &&
              !busy
            }
            aria-hidden="true"
          />
          <div>
            <strong>
              {paypalAgentConnectionLabel(connection, busy, statusUnavailable)}
            </strong>
            <AgentUsage
              connection={connection}
              statusUnavailable={statusUnavailable || busy}
            />
            {!connection && !statusUnavailable && !busy && (
              <p>A PayPal session in Chat is needed to connect.</p>
            )}
          </div>
        </div>
        <span className="paypal-agent-rate">Test funds</span>
      </div>
      <div className="paypal-agent-section-heading">
        <h3>Choose an app</h3>
        <span>One connection, all your agents</span>
      </div>
      <ClientSelector client={client} select={setClient} />
      <PaypalAgentSetup
        connection={connection}
        client={client}
        busy={busy}
        statusUnavailable={statusUnavailable}
        run={run}
        copy={copy}
        onlyConnected={onlyConnected}
      />
      <SandboxUsageDetails />
      {notice && (
        <p className="chat-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
