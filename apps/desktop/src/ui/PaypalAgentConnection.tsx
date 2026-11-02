// Guides local agent connections to the existing shared PayPal Sandbox session.
import { useState } from 'react';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';

import {
  claudeCodeConfig,
  claudeCodePowerShellConfig,
  codexConfig,
  DESKTOP_PAYPAL_AGENT,
  opencodeConfig,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_CLIENT,
  PAYPAL_AGENT_USAGE_STATE,
  piConfig,
  piSettings,
  type PaypalAgentAction,
  type PaypalAgentClient,
  type PaypalAgentResult,
  type PaypalAgentUsageState,
} from '../paypal-agent-model';
import { paypalDollars } from '../paypal-model';
import { BUTTON_VARIANT } from './constants';
import { usePaypalAgentConnection } from './paypal-agent-connection-hook';
import { Badge, Button, Note } from './UI';

type Connection = NonNullable<PaypalAgentResult['connection']>;
type DetailProps = {
  connection: Connection;
  client: PaypalAgentClient;
  busy: boolean;
  run: (action: PaypalAgentAction) => Promise<void>;
  copy: (value: string, label: string) => Promise<void>;
};

function AgentFields({ connection }: { connection: Connection }) {
  const [showKey, setShowKey] = useState(false);
  return (
    <>
      <label className="connection-field" htmlFor="agent-url">
        API URL
        <input
          id="agent-url"
          className="full-input"
          readOnly
          value={connection.url}
        />
      </label>
      <label className="connection-field" htmlFor="agent-key">
        API key
        <input
          id="agent-key"
          className="full-input"
          type={showKey ? 'text' : 'password'}
          readOnly
          value={connection.key}
        />
      </label>
      <Button onClick={() => setShowKey((visible) => !visible)}>
        {showKey ? 'Hide key' : 'Show key'}
      </Button>
      <label className="connection-field" htmlFor="agent-model">
        Model
        <input
          id="agent-model"
          className="full-input"
          readOnly
          value={connection.model}
        />
      </label>
    </>
  );
}

function clientConfig(client: PaypalAgentClient, connection: Connection) {
  if (client === PAYPAL_AGENT_CLIENT.CODEX) return codexConfig(connection);
  if (client === PAYPAL_AGENT_CLIENT.PI) return piConfig(connection);
  if (client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE)
    return claudeCodeConfig(connection);
  return opencodeConfig(connection);
}
function AgentActions({ connection, client, busy, run, copy }: DetailProps) {
  return (
    <>
      <div className="connection-actions">
        <Button
          onClick={() => {
            void copy(clientConfig(client, connection), 'Configuration');
          }}
        >
          {client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE
            ? 'Copy Claude Code bash/zsh configuration'
            : `Copy ${client} configuration`}
        </Button>
        {client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE && (
          <Button
            onClick={() => {
              void copy(
                claudeCodePowerShellConfig(connection),
                'PowerShell configuration',
              );
            }}
          >
            Copy Claude Code PowerShell configuration
          </Button>
        )}
        {client === PAYPAL_AGENT_CLIENT.PI && (
          <Button
            onClick={() => {
              void copy(piSettings(), 'Pi settings');
            }}
          >
            Copy Pi settings
          </Button>
        )}
        <Button
          onClick={() => {
            void copy(connection.key, 'API key');
          }}
        >
          Copy API key
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void run(PAYPAL_AGENT_ACTION.DISCONNECT);
          }}
        >
          Disconnect
        </Button>
      </div>
    </>
  );
}

function ClientInstructions({ client }: { client: PaypalAgentClient }) {
  if (client === PAYPAL_AGENT_CLIENT.CODEX)
    return (
      <p className="modal-note">
        Merge the configuration into your trusted project's .codex/config.toml,
        set GYBLOS_API_KEY in its environment, then start Codex CLI. This
        text-only configuration disables web search, multiple agents and image
        tools, as well as automatic provider retries.
      </p>
    );
  if (client === PAYPAL_AGENT_CLIENT.PI)
    return (
      <p className="modal-note">
        Create a new, private Pi agent directory and set PI_CODING_AGENT_DIR to
        its path. Save the copied configuration as models.json and the copied
        settings as settings.json there. Set GYBLOS_API_KEY in that environment
        and select the Gyblos model. The new directory does not inherit your Pi
        settings or extensions; project settings can still override it. Pi's
        estimate does not show Gyblos's fixed per-inference charge; check usage
        here.
      </p>
    );
  if (client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE)
    return (
      <p className="modal-note">
        Set GYBLOS_API_KEY in your terminal and run the copied environment
        settings there. A starting point is: claude --bare --tools default
        --append-system-prompt 'Use only required tool parameters unless
        explicitly needed.' This uses a local non-Claude model and is an
        experimental gateway configuration.
      </p>
    );
  return (
    <p className="modal-note">
      Add the configuration to your project's opencode.json and set
      GYBLOS_API_KEY in OpenCode's environment. It selects Gyblos and disables
      automatic titles in that project.
    </p>
  );
}
function AgentDetails(props: DetailProps) {
  return (
    <div className="connection-form">
      <AgentFields connection={props.connection} />
      <ClientInstructions client={props.client} />
      <p className="modal-note">
        All tools share this connection and session limit. Disconnecting revokes
        access for all tools. The URL and key change for each PayPal session or
        when you disconnect.
      </p>
      <AgentActions {...props} />
    </div>
  );
}

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
            Session maximum: {paypalDollars(connection.limitCents)} · Recorded
            usage: {paypalDollars(connection.spentCents)} · Remaining:{' '}
            {paypalDollars(connection.limitCents - connection.spentCents)}
          </p>
        ))}
    </>
  );
}
function RetryDisconnect({ busy, run }: Pick<DetailProps, 'busy' | 'run'>) {
  return (
    <Button
      disabled={busy}
      onClick={() => {
        void run(PAYPAL_AGENT_ACTION.DISCONNECT);
      }}
    >
      Retry disconnect
    </Button>
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
    <section className="paypal-session" aria-label="Agent sandbox connection">
      <div className="paypal-session-heading">
        <strong>Connect an agent</strong>
        <Badge>PayPal Sandbox</Badge>
      </div>
      <p>
        Your agent uses the same approved session and local seller as your
        PayPal chat. Keep Gyblos open while the tool runs.
      </p>
      <p>
        Approve a session in Chat first. Each completed agent inference uses{' '}
        {paypalDollars(PAYPAL_SANDBOX.messageCents)} of the session limit, even
        if delivery fails. One instruction can require several inferences. A
        started inference can finish and count after the agent disconnects.
        Settle the session in Chat when finished.
      </p>
      <p>
        An identical request without an operation key may be rejected to avoid a
        repeated charge. Some tools do not send such a key.
      </p>
      <div
        className="connection-actions"
        role="group"
        aria-label="Choose an agent"
      >
        {Object.values(PAYPAL_AGENT_CLIENT).map((item) => (
          <Button
            key={item}
            aria-pressed={client === item}
            onClick={() => setClient(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      <AgentUsage
        connection={connection}
        statusUnavailable={statusUnavailable || busy}
      />
      {!connection && !onlyConnected && (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={busy}
          onClick={() => {
            void run(PAYPAL_AGENT_ACTION.CONNECT);
          }}
        >
          Create shared local connection
        </Button>
      )}
      {connection?.usageState ===
        PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED && (
        <RetryDisconnect busy={busy} run={run} />
      )}
      {connection &&
        !connection.disconnecting &&
        connection.usageState !==
          PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED && (
          <AgentDetails
            connection={connection}
            client={client}
            busy={busy}
            run={run}
            copy={copy}
          />
        )}
      <Note>
        The agent uses the local {DESKTOP_PAYPAL_AGENT.MODEL} model. Chat keeps
        its existing model, which must be installed to send chat messages.
      </Note>
      {notice && (
        <p className="chat-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
