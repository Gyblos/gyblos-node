// Guides one OpenCode connection to the existing local PayPal Sandbox session.
import { useEffect, useRef, useState } from 'react';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';

import {
  agentFailure,
  DESKTOP_PAYPAL_AGENT,
  opencodeConfig,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentErrorMessage,
  retainPaypalAgentStatus,
  type PaypalAgentAction,
  type PaypalAgentResult,
  type PaypalAgentUsageState,
} from '../paypal-agent-model';
import { paypalDollars } from '../paypal-model';
import { writeClipboardText } from './clipboard';
import { BUTTON_VARIANT, COPY_RESULT } from './constants';
import { Badge, Button, Note } from './UI';

declare global {
  interface Window {
    desktopPaypalAgent?: {
      run(request: { action: PaypalAgentAction }): Promise<PaypalAgentResult>;
    };
  }
}

function actionFailure(
  action: PaypalAgentAction,
  error: PaypalAgentResult['error'],
) {
  return action === PAYPAL_AGENT_ACTION.DISCONNECT
    ? 'Could not confirm disconnection. The agent may still be connected; try again.'
    : paypalAgentErrorMessage(error);
}
function usePaypalAgentConnection() {
  const [result, setResult] = useState<PaypalAgentResult>({
    connection: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const connection = result.connection;
  useEffect(() => {
    mounted.current = true;
    async function refresh() {
      if (busyRef.current) return;
      const request = ++sequence.current;
      const next = await window.desktopPaypalAgent
        ?.run({ action: PAYPAL_AGENT_ACTION.STATUS })
        .catch(() => agentFailure());
      if (mounted.current && request === sequence.current) {
        setResult((previous) => retainPaypalAgentStatus(previous, next).result);
        setStatusUnavailable(!next || !!next.error);
      }
    }
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, DESKTOP_PAYPAL_AGENT.POLL_MS);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      window.clearInterval(interval);
    };
  }, []);
  async function run(action: PaypalAgentAction) {
    if (busyRef.current) return;
    busyRef.current = true;
    sequence.current += 1;
    setBusy(true);
    setNotice(
      action === PAYPAL_AGENT_ACTION.DISCONNECT
        ? 'Disconnecting. An inference already started can finish and count.'
        : '',
    );
    try {
      const next = await window.desktopPaypalAgent?.run({ action });
      if (!mounted.current) return;
      setResult((previous) => retainPaypalAgentStatus(previous, next).result);
      setStatusUnavailable(!next || !!next.error);
      if (!next || next.error)
        setNotice(actionFailure(action, next?.error ?? null));
      else setNotice('');
    } catch {
      if (mounted.current) {
        setStatusUnavailable(true);
        setNotice(
          'The local connection is unavailable; the agent may still be connected.',
        );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function copy(value: string, label: string) {
    if (!connection) return;
    const copied = await writeClipboardText(value, navigator.clipboard);
    if (mounted.current)
      setNotice(
        copied === COPY_RESULT.COPIED
          ? `${label} copied.`
          : 'Clipboard unavailable. Copy the values below.',
      );
  }
  return { connection, busy, notice, statusUnavailable, run, copy };
}

type Connection = NonNullable<PaypalAgentResult['connection']>;
type DetailProps = {
  connection: Connection;
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

function AgentActions({ connection, busy, run, copy }: DetailProps) {
  return (
    <>
      <div className="connection-actions">
        <Button
          onClick={() => {
            void copy(opencodeConfig(connection), 'Configuration');
          }}
        >
          Copy OpenCode configuration
        </Button>
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

function AgentDetails(props: DetailProps) {
  return (
    <div className="connection-form">
      <AgentFields connection={props.connection} />
      <p className="modal-note">
        Add the configuration to your project's opencode.json and set
        GYBLOS_API_KEY in OpenCode's environment. It selects Gyblos and disables
        automatic titles in that project. The URL and key change for each PayPal
        session or when you disconnect.
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
  if (onlyConnected && !connection && !statusUnavailable) return null;
  return (
    <section
      className="paypal-session"
      aria-label="OpenCode sandbox connection"
    >
      <div className="paypal-session-heading">
        <strong>Connect OpenCode</strong>
        <Badge>PayPal Sandbox</Badge>
      </div>
      <p>
        OpenCode uses the same approved session and local seller as your PayPal
        chat. Keep Gyblos open while the tool runs.
      </p>
      <p>
        Approve a session in Chat first. Each completed agent inference uses{' '}
        {paypalDollars(PAYPAL_SANDBOX.messageCents)} of the session limit, even
        if delivery fails. One instruction can require several inferences. A
        started inference can finish and count after OpenCode disconnects.
        Settle the session in Chat when finished.
      </p>
      <p>
        An identical request without an operation key may be rejected to avoid a
        repeated charge. OpenCode does not currently send such a key.
      </p>
      <AgentUsage
        connection={connection}
        statusUnavailable={statusUnavailable}
      />
      {!connection && !onlyConnected && (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={busy}
          onClick={() => {
            void run(PAYPAL_AGENT_ACTION.CONNECT);
          }}
        >
          Create local connection
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
