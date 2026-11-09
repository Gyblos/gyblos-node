// Guides API clients to one existing local connection, without changing payment authorization.
import { CheckCircle } from '@phosphor-icons/react';
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
  BUTTON_VARIANT,
  CONNECTION_PRESET,
  PAYPAL_AGENT_CARDS,
  type ConnectionPreset,
} from './constants';
import { Modal } from './Modal';
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
      className="ui-choice-grid ui-choice-grid--compact ui-choice-grid--four"
      role="radiogroup"
      aria-label="Choose a setup guide"
    >
      {PAYPAL_AGENT_CARDS.filter(
        (item) => item.client !== CONNECTION_PRESET.GENERIC,
      ).map((item) => (
        <ChoiceCard
          key={item.client}
          name="connection-preset"
          title={item.client}
          description={
            item.client === PAYPAL_AGENT_CLIENT.CLAUDE_CODE ? (
              <Badge>Experimental</Badge>
            ) : undefined
          }
          leading={<ServiceLogo service={item.client} />}
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
  onGuide: (preset: ConnectionPreset) => void;
}) {
  return (
    <section className="ui-separated-section" aria-label="Setup guides">
      <h3>{connected ? 'Set up your tool' : 'Explore setup guides'}</h3>
      <ClientSelector preset={preset} select={setPreset} />
      <div className="ui-guide-actions">
        <Button
          variant={
            connected ? BUTTON_VARIANT.PRIMARY : BUTTON_VARIANT.SECONDARY
          }
          aria-haspopup="dialog"
          onClick={() => onGuide(preset)}
        >
          Set up {preset}
        </Button>
        <Button onClick={() => onGuide(CONNECTION_PRESET.GENERIC)}>
          Other tools
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
  const [confirm, setConfirm] = useState(false);
  if (!connection) return null;
  const failed =
    connection.usageState === PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED;
  return (
    <section className="ui-separated-section" aria-label="Connection access">
      <h3>Connection access</h3>
      <p className="ui-help-text">Stop new requests from connected tools.</p>
      <Button
        disabled={busy || connection.disconnecting}
        onClick={() => setConfirm(true)}
      >
        {failed
          ? 'Retry disconnect'
          : connection.disconnecting
            ? 'Disconnecting…'
            : 'Disconnect all tools'}
      </Button>
      <p className="ui-help-text">
        Shared by all tools. An inference already running can finish and count.
      </p>
      {(connection.usageUncertain || statusUnavailable) && (
        <Button onClick={onPayments}>Review payments</Button>
      )}
      {confirm && (
        <Modal title="Disconnect all tools?" close={() => setConfirm(false)}>
          <div className="ui-section">
            <p className="ui-help-text">
              Stops new requests from every tool using this connection. An
              inference already running can finish and count. Your payment
              session stays open.
            </p>
            <div className="ui-inline-actions">
              <Button onClick={() => setConfirm(false)}>Keep connection</Button>
              <Button
                variant={BUTTON_VARIANT.SECONDARY}
                onClick={() => {
                  setConfirm(false);
                  void run(PAYPAL_AGENT_ACTION.DISCONNECT);
                }}
              >
                Disconnect all tools
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ConnectionHeading({
  connection,
  busy,
  statusUnavailable,
  run,
}: Pick<
  ReturnType<typeof usePaypalAgentConnection>,
  'connection' | 'busy' | 'statusUnavailable' | 'run'
>) {
  const ready = paypalAgentIsReady(connection, busy, statusUnavailable);
  return (
    <>
      {ready && (
        <div className="ui-connection-state-label">
          <CheckCircle size={18} aria-hidden="true" />
          <span>Connection ready</span>
        </div>
      )}
      {!ready && (connection || statusUnavailable || busy) && (
        <p className="ui-inline-notice" role="status">
          {statusUnavailable
            ? 'The local API status is not confirmed. Check again before starting requests.'
            : busy
              ? 'Checking the local API.'
              : connection && connectionUsageMessage(connection.usageState)}
        </p>
      )}
      {statusUnavailable && !busy && (
        <Button
          onClick={() => {
            void run(PAYPAL_AGENT_ACTION.STATUS);
          }}
        >
          Check connection
        </Button>
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
    PAYPAL_AGENT_CLIENT.OPENCODE,
  );
  const [guidePreset, setGuidePreset] = useState<ConnectionPreset | null>(null);
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
          onGuide={setGuidePreset}
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
        {guidePreset && (
          <ConnectionGuide
            {...endpoint}
            preset={guidePreset}
            close={() => setGuidePreset(null)}
          />
        )}
      </div>
    </WorkspaceLayout>
  );
}
