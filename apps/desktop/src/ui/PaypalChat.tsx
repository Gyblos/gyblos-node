// Renders the real local PayPal Sandbox session without preview responses or tools.
import { ArrowDown, ArrowUp } from '@phosphor-icons/react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import { DESKTOP_PAYPAL_AGENT } from '../paypal-agent-model';
import { PaypalChatController } from '../paypal-chat';
import {
  paypalDollars as dollars,
  PAYPAL_DESKTOP_ERROR,
  paypalActivityLabel,
  paypalAmountsAvailable,
  paypalFailure,
  type PaypalRequest,
  type PaypalResult,
} from '../paypal-model';
import type { DesktopPaypalStatus } from '../paypal-session';
import { ChatComposer } from './ChatComposer';
import { ChatUserMessage } from './ChatUserMessage';
import { BUTTON_VARIANT, CHAT_ROLE } from './constants';
import { MessageText } from './MessageText';
import { CheckStatus, PaypalCheckoutActions } from './PaypalCheckoutActions';
import { PaypalAssistantHeading, PaypalPendingMessage } from './PaypalMessage';
import { Badge, Button, IconButton } from './UI';
import { usePaypalChatScroll } from './usePaypalChatScroll';

declare global {
  interface Window {
    desktopPaypal?: {
      run(request: PaypalRequest): Promise<PaypalResult>;
      onReturn?(listener: () => void): () => void;
      onCancel?(listener: () => void): () => void;
    };
  }
}

type Snapshot = ReturnType<PaypalChatController['getSnapshot']>;
type ChatProps = { chat: PaypalChatController; state: Snapshot };

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

function SessionActions({ chat, state }: ChatProps) {
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
          Check Sandbox
        </Button>
      )}
      {canCreate && (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={state.busy}
          onClick={() => {
            void chat.startCheckout();
          }}
        >
          Continue with PayPal
        </Button>
      )}
      {phase === PAYPAL_SESSION_PHASE.CREATED && (
        <PaypalCheckoutActions chat={chat} state={state} />
      )}
      {phase === PAYPAL_SESSION_PHASE.ACTIVE && (
        <Button
          disabled={state.busy || !!state.pendingMessageId}
          onClick={() => {
            void chat.finish();
          }}
        >
          Review and close session
        </Button>
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
      <div className="ui-help-text">
        <p>One local seller. Messages are independent and have no web tools.</p>
        <p>
          The session authorizes a limit in test funds. Each acknowledged chat
          response or completed agent inference uses the session's rate shown
          above. An agent can use multiple inferences, and a completed inference
          counts even if its response cannot be delivered. An inference already
          started can finish and count after the agent disconnects. Closing
          attempts to capture recorded usage or void an unused authorization.
        </p>
      </div>
      {phase === PAYPAL_SESSION_PHASE.COMPLETED && (
        <p>Sandbox payment captured for recorded usage.</p>
      )}
      {phase === PAYPAL_SESSION_PHASE.VOIDED && (
        <p>Unused sandbox authorization voided.</p>
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
          Checking status only updates the local view. Do not retry payment or
          remove its record.
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

function SessionPanel({ chat, state }: ChatProps) {
  return (
    <section className="paypal-session" aria-label="PayPal Sandbox session">
      <div className="paypal-session-heading">
        <strong>PayPal Sandbox</strong>
        <Badge>Test funds</Badge>
        <Badge>
          {paypalActivityLabel(state.statusFresh ? state.status : null)}
        </Badge>
        {state.statusFresh &&
          state.status &&
          paypalAmountsAvailable(state.status) && (
            <span className="paypal-session-usage">
              <strong>{dollars(state.status.spentCents)}</strong> recorded ·
              session limit {dollars(state.status.limitCents)} ·{' '}
              {dollars(state.status.messageCents)} per chat reply or agent
              inference
            </span>
          )}
      </div>
      <SessionMessages state={state} />
      <SessionActions chat={chat} state={state} />
      {state.notice && (
        <p className="chat-notice" role="status">
          {state.notice}
        </p>
      )}
    </section>
  );
}

function Transcript({ state, active }: { state: Snapshot; active: boolean }) {
  const scroll = usePaypalChatScroll(state, active);
  return (
    <>
      <div
        ref={scroll.viewport}
        className="conversation"
        role="log"
        aria-label="Sandbox conversation"
        aria-live="polite"
        onScroll={scroll.onScroll}
      >
        <div className="chat-transcript">
          {state.messages.map((message, index) =>
            message.role === CHAT_ROLE.USER ? (
              <ChatUserMessage key={index} text={message.text} />
            ) : (
              <article
                className="chat-answer paypal-answer"
                aria-label="Assistant"
                key={index}
              >
                <PaypalAssistantHeading model={state.model} />
                <MessageText text={message.text || '(Empty response)'} />
              </article>
            ),
          )}
          {state.pendingPrompt && (
            <PaypalPendingMessage
              model={state.model}
              prompt={state.pendingPrompt}
            />
          )}
        </div>
      </div>
      {!scroll.nearBottom && (
        <div className="latest-wrap">
          <Button onClick={scroll.latest}>
            <ArrowDown size={14} /> Latest message
          </Button>
        </div>
      )}
    </>
  );
}

function Composer({ chat, state }: ChatProps) {
  const status = state.status;
  const canSend =
    state.statusFresh &&
    status !== null &&
    status.phase === PAYPAL_SESSION_PHASE.ACTIVE &&
    !status.expired &&
    status.remainingAttempts > 0 &&
    status.spentCents + status.messageCents <= status.limitCents &&
    !state.pendingMessageId &&
    !state.busy &&
    !!state.draft.trim();
  return (
    <div className="composer-wrap">
      <ChatComposer
        placeholder="Message the local model"
        value={state.draft}
        onChange={(value) => chat.setDraft(value)}
        onSubmit={() => {
          void chat.send();
        }}
      >
        <div className="composer-leading">
          <span>{state.model ?? 'Local model'}</span>
        </div>
        <div className="composer-actions">
          <span>{state.busy ? 'Working…' : 'Sandbox session'}</span>
          <IconButton
            variant={BUTTON_VARIANT.PRIMARY}
            className="ui-composer-action"
            type="submit"
            label="Send message"
            disabled={!canSend}
          >
            <ArrowUp size={16} weight="bold" />
          </IconButton>
        </div>
      </ChatComposer>
      <p className="composer-note">
        Each message is independent and must fit the local model's context. A
        response must be acknowledged before sending another.
      </p>
    </div>
  );
}

export function PaypalChat({
  active,
  monitor,
  onStatusChange,
  onFreshnessChange,
}: {
  active: boolean;
  monitor: boolean;
  onStatusChange: (status: DesktopPaypalStatus | null) => void;
  onFreshnessChange: (fresh: boolean) => void;
}) {
  const [chat] = useState(
    () =>
      new PaypalChatController(async (request) =>
        window.desktopPaypal
          ? window.desktopPaypal.run(request)
          : paypalFailure(PAYPAL_DESKTOP_ERROR.UNAVAILABLE),
      ),
  );
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  useEffect(() => {
    onStatusChange(state.status);
    onFreshnessChange(state.statusFresh);
  }, [onFreshnessChange, onStatusChange, state.status, state.statusFresh]);
  useEffect(() => {
    const removeReturn = window.desktopPaypal?.onReturn?.(() => {
      void chat.returnedFromPaypal();
    });
    const removeCancel = window.desktopPaypal?.onCancel?.(() => {
      void chat.cancelledFromPaypal();
    });
    return () => {
      removeReturn?.();
      removeCancel?.();
    };
  }, [chat]);
  useEffect(() => {
    if (!active && !monitor) return;
    void chat.refresh();
    const interval = window.setInterval(() => {
      void chat.poll();
    }, DESKTOP_PAYPAL_AGENT.POLL_MS);
    return () => window.clearInterval(interval);
  }, [active, chat, monitor]);
  return (
    <main className="chat-page enhanced-chat paypal-chat">
      <SessionPanel chat={chat} state={state} />
      <div className="chat-stage">
        <Transcript state={state} active={active} />
        <Composer chat={chat} state={state} />
      </div>
    </main>
  );
}
