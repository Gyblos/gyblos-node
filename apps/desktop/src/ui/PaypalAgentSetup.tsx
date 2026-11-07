// Presents the selected agent's local connection and copy actions.
// The session and credentials remain owned by the desktop host.
import { Copy } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  canCreatePaypalAgent,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_CLIENT,
  PAYPAL_AGENT_COPY,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentNeedsPayments,
  type PaypalAgentAction,
  type PaypalAgentClient,
  type PaypalAgentCopyTarget,
  type PaypalAgentResult,
} from '../paypal-agent-model';
import { BUTTON_VARIANT } from './constants';
import { FormActions, FormField, FormInput } from './Form';
import { ServiceLogo } from './ServiceLogo';
import { Button } from './UI';

type Connection = NonNullable<PaypalAgentResult['connection']>;
type DetailProps = {
  connection: Connection;
  client: PaypalAgentClient;
  busy: boolean;
  run: (action: PaypalAgentAction) => Promise<void>;
  copy: (target: PaypalAgentCopyTarget, label: string) => Promise<void>;
};

function AgentFields({
  connection,
  copy,
}: Pick<DetailProps, 'connection' | 'copy'>) {
  const [showKey, setShowKey] = useState(false);
  return (
    <>
      <FormField htmlFor="agent-url" label="API URL">
        <FormInput id="agent-url" readOnly value={connection.url} />
      </FormField>
      <div className="paypal-agent-key-row">
        <FormField htmlFor="agent-key" label="API key">
          <FormInput
            id="agent-key"
            type={showKey ? 'text' : 'password'}
            readOnly
            value={connection.key}
          />
        </FormField>
        <Button
          variant={BUTTON_VARIANT.SECONDARY}
          onClick={() => {
            void copy(PAYPAL_AGENT_COPY.KEY, 'API key');
          }}
        >
          <Copy size={14} />
          Copy API key
        </Button>
        <Button onClick={() => setShowKey((visible) => !visible)}>
          {showKey ? 'Hide key' : 'Show key'}
        </Button>
      </div>
    </>
  );
}

function AgentActions({ client, busy, run, copy }: DetailProps) {
  return (
    <>
      <FormActions align="start">
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          onClick={() => {
            void copy(client, 'Configuration');
          }}
        >
          <Copy size={14} />
          {client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE
            ? 'Copy Claude Code bash/zsh configuration'
            : `Copy ${client} configuration`}
        </Button>
        {client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE && (
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            onClick={() => {
              void copy(
                PAYPAL_AGENT_COPY.CLAUDE_POWERSHELL,
                'PowerShell configuration',
              );
            }}
          >
            Copy Claude Code PowerShell configuration
          </Button>
        )}
        {client === PAYPAL_AGENT_CLIENT.PI && (
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            onClick={() => {
              void copy(PAYPAL_AGENT_COPY.PI_SETTINGS, 'Pi settings');
            }}
          >
            Copy Pi settings
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={() => {
            void run(PAYPAL_AGENT_ACTION.DISCONNECT);
          }}
        >
          Disconnect
        </Button>
      </FormActions>
    </>
  );
}

function ClientInstructions({ client }: { client: PaypalAgentClient }) {
  if (client === PAYPAL_AGENT_CLIENT.CODEX)
    return (
      <ol className="ui-steps">
        <li>
          Merge the copied configuration into your trusted project's
          .codex/config.toml.
        </li>
        <li>
          Set GYBLOS_API_KEY in that project's environment and start Codex CLI.
        </li>
        <li>
          Web search, multiple agents, image tools and automatic provider
          retries are disabled in this text-only configuration.
        </li>
      </ol>
    );
  if (client === PAYPAL_AGENT_CLIENT.PI)
    return (
      <ol className="ui-steps">
        <li>
          Create a new private Pi directory and set PI_CODING_AGENT_DIR to its
          path.
        </li>
        <li>
          Save the copied model configuration as models.json and the copied Pi
          settings as settings.json in that directory.
        </li>
        <li>
          Set GYBLOS_API_KEY in that environment, then select the Gyblos model.
        </li>
        <li>
          The directory does not inherit your Pi settings or extensions; project
          settings may override it. Pi's estimate does not show the fixed
          per-inference charge, so check usage here.
        </li>
      </ol>
    );
  if (client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE)
    return (
      <ol className="ui-steps">
        <li>Open a new dedicated terminal and set GYBLOS_API_KEY.</li>
        <li>
          Run the copied environment settings there. They remain in that
          terminal until it closes.
        </li>
        <li>
          Start with: claude --bare --tools default --append-system-prompt 'Use
          only required tool parameters unless explicitly needed.'
        </li>
        <li>This experimental gateway uses a local non-Claude model.</li>
      </ol>
    );
  return (
    <ol className="ui-steps">
      <li>Merge the copied configuration into your project's opencode.json.</li>
      <li>Set GYBLOS_API_KEY in OpenCode's environment.</li>
      <li>
        The configuration selects Gyblos and disables automatic titles in that
        project.
      </li>
    </ol>
  );
}
function AgentDetails(props: DetailProps) {
  return (
    <div className="paypal-agent-setup-body">
      <AgentActions {...props} />
      <section className="ui-section" aria-label="Setup instructions">
        <h4 className="ui-subheading">Setup instructions</h4>
        <ClientInstructions client={props.client} />
      </section>
      <section className="ui-section" aria-label="Connection details">
        <h4 className="ui-subheading">Connection details</h4>
        <div className="ui-form">
          <AgentFields connection={props.connection} copy={props.copy} />
          <p className="modal-note">
            All apps share this connection. Disconnecting revokes access for
            every app; the URL and key change with a new connection.
          </p>
        </div>
      </section>
    </div>
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
type SetupProps = Omit<DetailProps, 'connection'> & {
  connection: PaypalAgentResult['connection'];
  onlyConnected: boolean;
  statusUnavailable: boolean;
  sessionReady: boolean;
  onPayments: () => void;
};
export function PaypalAgentSetup({
  connection,
  client,
  busy,
  run,
  copy,
  onlyConnected,
  statusUnavailable,
  sessionReady,
  onPayments,
}: SetupProps) {
  return (
    <div className="paypal-agent-setup">
      <div className="paypal-agent-setup-heading">
        <span className="ui-icon-tile" aria-hidden="true">
          <ServiceLogo service={client} />
        </span>
        <div>
          <h3>Set up {client}</h3>
          <p>Connect {client} to Gyblos.</p>
        </div>
      </div>
      {paypalAgentNeedsPayments(connection, onlyConnected, sessionReady) && (
        <Button variant={BUTTON_VARIANT.PRIMARY} onClick={onPayments}>
          Go to Payments
        </Button>
      )}
      {connection && !sessionReady && (
        <Button variant={BUTTON_VARIANT.SECONDARY} onClick={onPayments}>
          Review payments
        </Button>
      )}
      {!connection && !onlyConnected && sessionReady && (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={
            !canCreatePaypalAgent(
              connection,
              statusUnavailable,
              busy,
              onlyConnected,
              sessionReady,
            )
          }
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
    </div>
  );
}
