// Guides API clients to one existing local connection, without changing payment authorization.
import { Code } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_CLIENT,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentIsReady,
} from '../paypal-agent-model';
import type { PaypalResult } from '../paypal-model';
import { ConnectionContext, connectionUsageMessage } from './ConnectionContext';
import {
  CONNECTION_PRESET,
  PAYPAL_AGENT_CARDS,
  type ConnectionPreset,
} from './constants';
import { usePaypalAgentConnection } from './paypal-agent-connection-hook';
import { ConnectionGuide, PaypalAgentSetup } from './PaypalAgentSetup';
import { ServiceLogo } from './ServiceLogo';
import { Badge, Button, ChoiceCard } from './UI';
import { WorkspaceLayout } from './WorkspaceLayout';

function ClientSelector({
  preset,
  select,
}: {
  preset: ConnectionPreset;
  select: (preset: ConnectionPreset) => void;
}) {
  return (
    <div
      className="ui-choice-grid ui-choice-grid--compact"
      role="radiogroup"
      aria-label="Choose a setup guide"
    >
      {PAYPAL_AGENT_CARDS.map((item) => (
        <ChoiceCard
          key={item.client}
          name="connection-preset"
          title={item.client}
          description={
            item.client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE ? (
              <Badge>Experimental</Badge>
            ) : undefined
          }
          leading={
            item.client === CONNECTION_PRESET.GENERIC ? (
              <Code size={24} />
            ) : (
              <ServiceLogo service={item.client} />
            )
          }
          selected={preset === item.client}
          onSelect={() => select(item.client)}
          stacked
        />
      ))}
    </div>
  );
}

type Props = {
  onlyConnected?: boolean;
  sessionReady: boolean;
  sessionStatus: PaypalResult['status'];
  sessionFresh: boolean;
  contextOpen: boolean;
  onCloseContext: () => void;
  onPayments: () => void;
};

function SetupGuides({
  preset,
  setPreset,
  connected,
  onGuide,
}: {
  preset: ConnectionPreset;
  setPreset: (preset: ConnectionPreset) => void;
  connected: boolean;
  onGuide: () => void;
}) {
  return (
    <section className="ui-separated-section" aria-label="Setup guides">
      <h3>{connected ? 'Set up your tool' : 'Setup guides'}</h3>
      <ClientSelector preset={preset} select={setPreset} />
      <div className="ui-guide-actions">
        <p className="ui-help-text">
          {preset === CONNECTION_PRESET.GENERIC
            ? 'OpenAI-compatible · Chat Completions'
            : 'A setup guide for this shared connection.'}
        </p>
        <Button onClick={onGuide}>
          {preset === CONNECTION_PRESET.GENERIC
            ? 'View example request'
            : `Set up ${preset}`}
        </Button>
      </div>
    </section>
  );
}

function ConnectionFooter({
  connection,
  busy,
  statusUnavailable,
  run,
  onPayments,
}: Pick<
  ReturnType<typeof usePaypalAgentConnection>,
  'connection' | 'busy' | 'run' | 'statusUnavailable'
> &
  Pick<Props, 'onPayments'>) {
  if (!connection) return null;
  const failed =
    connection.usageState === PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED;
  return (
    <div className="ui-connection-footer">
      <Button
        disabled={busy || connection.disconnecting}
        onClick={() => {
          void run(PAYPAL_AGENT_ACTION.DISCONNECT);
        }}
      >
        {failed
          ? 'Retry disconnect'
          : connection.disconnecting
            ? 'Disconnecting…'
            : 'Disconnect'}
      </Button>
      <p className="ui-help-text">
        Shared by all tools. An inference already running can finish and count.
      </p>
      {(connection.usageUncertain || statusUnavailable) && (
        <Button onClick={onPayments}>Review payments</Button>
      )}
    </div>
  );
}

function ConnectionHeading({
  connection,
  busy,
  statusUnavailable,
}: Pick<
  ReturnType<typeof usePaypalAgentConnection>,
  'connection' | 'busy' | 'statusUnavailable'
>) {
  const ready = paypalAgentIsReady(connection, busy, statusUnavailable);
  return (
    <>
      <header className="ui-page-heading">
        <h2>Use Gyblos in your tools</h2>
        <p>
          {ready
            ? 'Your API details, ready for a compatible app.'
            : connection
              ? 'Review this connection before starting another request.'
              : 'Create an API key and local URL for compatible apps.'}
        </p>
      </header>
      {connection && !ready && (
        <p className="ui-inline-notice" role="status">
          {statusUnavailable
            ? 'The local API status cannot be checked. Review Payments before starting requests.'
            : busy
              ? 'Checking the local API.'
              : connectionUsageMessage(connection.usageState)}
        </p>
      )}
    </>
  );
}

export function PaypalAgentConnection({
  onlyConnected = false,
  sessionReady,
  sessionStatus,
  sessionFresh,
  contextOpen,
  onCloseContext,
  onPayments,
}: Props) {
  const endpoint = usePaypalAgentConnection();
  const { connection, busy, notice, statusUnavailable, run } = endpoint;
  const [preset, setPreset] = useState<ConnectionPreset>(
    CONNECTION_PRESET.GENERIC,
  );
  const [guideOpen, setGuideOpen] = useState(false);
  const setup = { ...endpoint, onlyConnected, sessionReady, onPayments };
  const context = (
    <ConnectionContext
      {...endpoint}
      sessionReady={sessionReady}
      sessionStatus={sessionStatus}
      sessionFresh={sessionFresh}
      onPayments={onPayments}
    />
  );
  return (
    <WorkspaceLayout
      context={context}
      contextOpen={contextOpen}
      onCloseContext={onCloseContext}
    >
      <div className="ui-connection-page">
        <ConnectionHeading {...endpoint} />
        <PaypalAgentSetup {...setup} />
        <SetupGuides
          preset={preset}
          setPreset={setPreset}
          connected={!!connection}
          onGuide={() => setGuideOpen(true)}
        />
        <ConnectionFooter
          connection={connection}
          busy={busy}
          statusUnavailable={statusUnavailable}
          run={run}
          onPayments={onPayments}
        />
        {notice && (
          <p className="chat-notice" role="status">
            {notice}
          </p>
        )}
        {guideOpen && (
          <ConnectionGuide
            {...endpoint}
            preset={preset}
            close={() => setGuideOpen(false)}
          />
        )}
      </div>
    </WorkspaceLayout>
  );
}
