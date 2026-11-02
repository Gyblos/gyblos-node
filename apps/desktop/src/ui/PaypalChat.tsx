// Renders the real local PayPal Sandbox session without preview responses or tools.
import { ArrowUp } from '@phosphor-icons/react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import { DESKTOP_PAYPAL_AGENT } from '../paypal-agent-model';
import { PaypalChatController } from '../paypal-chat';
import {
  PAYPAL_DESKTOP_ERROR,
  paypalFailure,
  type PaypalRequest,
  type PaypalResult,
} from '../paypal-model';
import { BUTTON_VARIANT, CHAT_ROLE } from './constants';
import { MessageText } from './MessageText';
import { Badge, Button, IconButton } from './UI';

declare global {
  interface Window {
    desktopPaypal?: { run(request: PaypalRequest): Promise<PaypalResult> };
  }
}

type Snapshot = ReturnType<PaypalChatController['getSnapshot']>;
type ChatProps = { chat: PaypalChatController; state: Snapshot };
const dollars = (cents: number) =>
  `USD ${(cents / PAYPAL_SANDBOX.centsPerDollar).toFixed(2)}`;

function uncertain(state: Snapshot) {
  const phase = state.status?.phase;
  return (
    phase === PAYPAL_SESSION_STATUS.BLOCKED ||
    phase === PAYPAL_SESSION_PHASE.CREATING ||
    phase === PAYPAL_SESSION_PHASE.AUTHORIZING ||
    phase === PAYPAL_SESSION_PHASE.CAPTURING ||
    phase === PAYPAL_SESSION_PHASE.VOIDING
  );
}

function CreatedActions({ chat, state }: ChatProps) {
  return (
    <>
      <Button
        disabled={state.busy || !state.status?.approvalLinkAvailable}
        onClick={() => {
          void chat.openApproval();
        }}
      >
        Open PayPal Sandbox
      </Button>
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={state.busy}
        onClick={() => {
          void chat.approve();
        }}
      >
        I approved · start session
      </Button>
      <Button
        disabled={state.busy}
        onClick={() => {
          void chat.abandon();
        }}
      >
        Abandon unapproved order
      </Button>
    </>
  );
}

function SessionActions({ chat, state }: ChatProps) {
  const phase = state.status?.phase;
  const canCreate =
    phase === PAYPAL_SESSION_STATUS.READY ||
    phase === PAYPAL_SESSION_PHASE.COMPLETED ||
    phase === PAYPAL_SESSION_PHASE.VOIDED ||
    phase === PAYPAL_SESSION_PHASE.CANCELLED;
  return (
    <div className="paypal-session-actions">
      {!state.status && (
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
            void chat.create();
          }}
        >
          Create sandbox session
        </Button>
      )}
      {phase === PAYPAL_SESSION_PHASE.CREATED && (
        <CreatedActions chat={chat} state={state} />
      )}
      {phase === PAYPAL_SESSION_PHASE.ACTIVE && (
        <Button
          disabled={state.busy || !!state.pendingMessageId}
          onClick={() => {
            void chat.finish();
          }}
        >
          Close session and settle
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
      {(uncertain(state) ||
        phase === PAYPAL_SESSION_PHASE.EXECUTING ||
        (phase === PAYPAL_SESSION_PHASE.MESSAGE_PENDING &&
          !state.pendingMessageId)) && (
        <Button
          disabled={state.busy}
          onClick={() => {
            void chat.refresh();
          }}
        >
          Check status
        </Button>
      )}
    </div>
  );
}

function SessionPanel({ chat, state }: ChatProps) {
  const phase = state.status?.phase;
  return (
    <section className="paypal-session" aria-label="PayPal Sandbox session">
      <div className="paypal-session-heading">
        <strong>PayPal Sandbox</strong>
        <Badge>Test funds</Badge>
        <span>{state.model ?? 'Local inference'}</span>
      </div>
      <p>
        One local seller · independent messages · no conversation context or web
        tools.
      </p>
      {state.status && (
        <p>
          Session maximum: {dollars(state.status.limitCents)} · Recorded usage:{' '}
          {dollars(state.status.spentCents)} ·{' '}
          {dollars(state.status.messageCents)} per acknowledged chat response or
          completed agent inference
        </p>
      )}
      <p>
        Sandbox sessions authorize up to USD 1 in test funds. Each completed
        agent inference uses USD 0.10, even if the response cannot be delivered.
        One instruction can require multiple inferences. An inference already
        started can finish and count after the agent disconnects. Closing the
        session captures the recorded usage.
      </p>
      {phase === PAYPAL_SESSION_PHASE.COMPLETED && (
        <p>Sandbox payment captured for recorded usage.</p>
      )}
      {phase === PAYPAL_SESSION_PHASE.VOIDED && (
        <p>Unused sandbox authorization voided.</p>
      )}
      {phase === PAYPAL_SESSION_PHASE.ACTIVE && state.status?.expired && (
        <p>Session expired for new messages. Close it to settle.</p>
      )}
      {phase === PAYPAL_SESSION_PHASE.CREATED &&
        !state.status?.approvalLinkAvailable && (
          <p>
            The old checkout cannot be reopened safely after restarting. If
            already approved, start the session; otherwise abandon this order
            and create a new one. Do not use a checkout tab opened before the
            restart.
          </p>
        )}
      {uncertain(state) && (
        <p>
          Session needs review and the usage shown may be uncertain. Do not
          retry payment or remove its record.
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
      <SessionActions chat={chat} state={state} />
      {state.notice && (
        <p className="chat-notice" role="status">
          {state.notice}
        </p>
      )}
    </section>
  );
}

function Transcript({ state }: { state: Snapshot }) {
  return (
    <div
      className="conversation"
      role="log"
      aria-label="Sandbox conversation"
      aria-live="polite"
    >
      <div className="chat-transcript">
        {state.messages.map((message, index) =>
          message.role === CHAT_ROLE.USER ? (
            <article className="chat-user" key={index}>
              <p>{message.text}</p>
            </article>
          ) : (
            <article className="chat-answer" key={index}>
              <header className="answer-heading">
                <span>{state.model ?? 'Local model'}</span>
                <Badge>PayPal Sandbox</Badge>
              </header>
              <MessageText text={message.text || '(Empty response)'} />
            </article>
          ),
        )}
      </div>
    </div>
  );
}

function Composer({ chat, state }: ChatProps) {
  const status = state.status;
  const canSend =
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
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void chat.send();
        }}
      >
        <textarea
          aria-label="Your message"
          placeholder="Message the local model"
          value={state.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              event.key === 'Enter' &&
              !event.shiftKey
            ) {
              event.preventDefault();
              void chat.send();
            }
          }}
        />
        <div className="composer-bottom">
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
        </div>
      </form>
      <p className="composer-note">
        Each message is independent and must fit the local model's context. A
        response must be acknowledged before sending another.
      </p>
    </div>
  );
}

export function PaypalChat({ active }: { active: boolean }) {
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
    if (!active) return;
    void chat.refresh();
    const interval = window.setInterval(() => {
      void chat.poll();
    }, DESKTOP_PAYPAL_AGENT.POLL_MS);
    return () => window.clearInterval(interval);
  }, [active, chat]);
  return (
    <main className="chat-page enhanced-chat paypal-chat">
      <SessionPanel chat={chat} state={state} />
      <div className="chat-stage">
        <Transcript state={state} />
        <Composer chat={chat} state={state} />
      </div>
    </main>
  );
}
