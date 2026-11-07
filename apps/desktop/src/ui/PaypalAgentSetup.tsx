// Local API fields and setup guides; credentials and clipboard remain owned by the host.
import { Key, Link } from '@phosphor-icons/react';

import {
  canCreatePaypalAgent,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_CLIENT,
  PAYPAL_AGENT_COPY,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentExample,
  paypalAgentNeedsPayments,
  type PaypalAgentAction,
  type PaypalAgentClient,
  type PaypalAgentCopyTarget,
  type PaypalAgentResult,
} from '../paypal-agent-model';
import {
  BUTTON_VARIANT,
  CONNECTION_PRESET,
  type ConnectionPreset,
} from './constants';
import { CopyField, FormActions } from './Form';
import { Modal } from './Modal';
import { Button } from './UI';

type SetupProps = {
  connection: PaypalAgentResult['connection'];
  busy: boolean;
  statusUnavailable: boolean;
  run: (action: PaypalAgentAction) => Promise<void>;
  copy: (target: PaypalAgentCopyTarget, label: string) => Promise<void>;
  onlyConnected: boolean;
  sessionReady: boolean;
  onPayments: () => void;
};

function ConnectionFields({
  connection,
  copy,
  busy,
  statusUnavailable,
}: Pick<SetupProps, 'connection' | 'copy' | 'busy' | 'statusUnavailable'>) {
  if (!connection) return null;
  const disabled =
    busy ||
    statusUnavailable ||
    connection.disconnecting ||
    connection.usageState === PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED;
  return (
    <section className="ui-form" aria-label="API connection details">
      <CopyField
        id="agent-key"
        label="API key"
        secret
        value={connection.key}
        actionLabel="Copy API key"
        disabled={disabled}
        onCopy={() => {
          void copy(PAYPAL_AGENT_COPY.KEY, 'API key');
        }}
      />
      <CopyField
        id="agent-url"
        label="Base URL"
        value={connection.url}
        actionLabel="Copy URL"
        disabled={disabled}
        onCopy={() => {
          void copy(PAYPAL_AGENT_COPY.URL, 'URL');
        }}
      />
      <CopyField
        id="agent-model"
        label="Model"
        value={connection.model}
        actionLabel="Copy model"
        disabled={disabled}
        onCopy={() => {
          void copy(PAYPAL_AGENT_COPY.MODEL, 'Model');
        }}
      />
      <p className="ui-help-text">
        Use these details in your app's provider settings.
      </p>
    </section>
  );
}

export function PaypalAgentSetup(props: SetupProps) {
  const {
    connection,
    busy,
    statusUnavailable,
    onlyConnected,
    sessionReady,
    run,
    onPayments,
  } = props;
  if (connection) return <ConnectionFields {...props} />;
  const paymentsNeeded = paypalAgentNeedsPayments(
    connection,
    onlyConnected,
    sessionReady,
  );
  return (
    <section className="ui-connection-entry" aria-label="Create API connection">
      <div className="ui-entry-art" aria-hidden="true">
        <Key size={40} />
        <Link size={40} />
      </div>
      <div className="ui-section">
        <h3>Your local API connection</h3>
        <p className="ui-help-text">One connection for your tools.</p>
        {paymentsNeeded ? (
          <Button variant={BUTTON_VARIANT.PRIMARY} onClick={onPayments}>
            Go to Payments
          </Button>
        ) : (
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
            Create API connection
          </Button>
        )}
        <div className="ui-inline-actions">
          <span className="ui-help-text">
            {sessionReady
              ? 'Payment session ready'
              : 'Prepare a payment session to connect.'}
          </span>
          <Button onClick={onPayments}>View payments</Button>
        </div>
      </div>
    </section>
  );
}

function ClientInstructions({ client }: { client: PaypalAgentClient }) {
  if (client === PAYPAL_AGENT_CLIENT.CODEX)
    return (
      <ol className="ui-steps">
        <li>
          Merge the provider configuration into your user-level
          ~/.codex/config.toml or a dedicated Codex profile.
        </li>
        <li>
          Set GYBLOS_API_KEY in your terminal and start Codex CLI with that
          configuration.
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
      <li>
        Merge the copied configuration into your project's opencode.json. This
        recipe uses the V1 provider format; newer versions may require the
        standard API details.
      </li>
      <li>Set GYBLOS_API_KEY in OpenCode's environment.</li>
      <li>
        The configuration selects Gyblos and disables automatic titles in that
        project.
      </li>
    </ol>
  );
}

function GuideActions({
  client,
  copy,
  disabled,
}: {
  client: PaypalAgentClient;
  copy: SetupProps['copy'];
  disabled: boolean;
}) {
  return (
    <FormActions align="start">
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={disabled}
        onClick={() => {
          void copy(client, 'Configuration');
        }}
      >
        {client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE
          ? 'Copy bash/zsh configuration'
          : `Copy ${client} configuration`}
      </Button>
      {client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE && (
        <Button
          disabled={disabled}
          onClick={() => {
            void copy(
              PAYPAL_AGENT_COPY.CLAUDE_POWERSHELL,
              'PowerShell configuration',
            );
          }}
        >
          Copy PowerShell configuration
        </Button>
      )}
      {client === PAYPAL_AGENT_CLIENT.PI && (
        <Button
          disabled={disabled}
          onClick={() => {
            void copy(PAYPAL_AGENT_COPY.PI_SETTINGS, 'Pi settings');
          }}
        >
          Copy Pi settings
        </Button>
      )}
    </FormActions>
  );
}

export function ConnectionGuide({
  preset,
  connection,
  busy,
  statusUnavailable,
  copy,
  close,
}: Pick<SetupProps, 'connection' | 'busy' | 'statusUnavailable' | 'copy'> & {
  preset: ConnectionPreset;
  close: () => void;
}) {
  const disabled =
    !connection ||
    busy ||
    statusUnavailable ||
    connection.disconnecting ||
    connection.usageState === PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED;
  return (
    <Modal
      title={
        preset === CONNECTION_PRESET.GENERIC
          ? 'OpenAI-compatible API'
          : `Set up ${preset}`
      }
      close={close}
    >
      <div className="ui-section">
        {preset === CONNECTION_PRESET.GENERIC ? (
          <>
            <p className="ui-help-text">
              Set your app's base URL, API key and model using your connection
              details. Text and supported tool calls use Chat Completions.
            </p>
            {connection && (
              <pre className="ui-code-block">
                {paypalAgentExample(connection)}
              </pre>
            )}
            <p className="ui-help-text">
              Set GYBLOS_API_KEY privately in your terminal before running the
              example. Running a request can consume the shared session limit.
            </p>
            <Button
              variant={BUTTON_VARIANT.PRIMARY}
              disabled={disabled}
              onClick={() => {
                void copy(PAYPAL_AGENT_COPY.EXAMPLE, 'Example request');
              }}
            >
              Copy example request
            </Button>
          </>
        ) : (
          <>
            <GuideActions client={preset} copy={copy} disabled={disabled} />
            <ClientInstructions client={preset} />
          </>
        )}
        <p className="ui-help-text">
          Each completed inference counts toward the shared limit, even if
          delivery fails. One instruction can need several inferences.
        </p>
        {!connection && (
          <p className="ui-help-text">
            Create a connection to copy its configuration.
          </p>
        )}
      </div>
    </Modal>
  );
}
