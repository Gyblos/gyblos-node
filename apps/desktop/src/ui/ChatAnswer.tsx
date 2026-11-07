// Presents a response on the shared reading surface with the Gyblos generation signal.
// Execution, clipboard state and session transitions remain with the caller.
import { ArrowClockwise, Check, Copy, Info } from '@phosphor-icons/react';

import { PAYMENT_METHOD } from '../paypal-model';
import {
  CHAT_PHASE,
  MESSAGE_STATE,
  type ChatMessage,
  type ChatRun,
} from './chat-state';
import { AssistantProgress } from './ChatMessageParts';
import { MessageText } from './MessageText';
import { SIGNAL_STATE, SignalMark } from './Signal';
import { IconButton } from './UI';

const PHASE_LABEL = {
  [CHAT_PHASE.CONNECTING]: 'Thinking…',
  [CHAT_PHASE.TOOLS]: 'Using tools…',
  [CHAT_PHASE.RESPONDING]: 'Writing…',
} as const;

type Props = {
  message: ChatMessage;
  run: ChatRun | null;
  copied: boolean;
  canReuse: boolean;
  reuseDisabled: boolean;
  onCopy: () => void;
  onReuse: () => void;
  onDetails: () => void;
};

function AnswerActions({
  message,
  copied,
  canReuse,
  reuseDisabled,
  onCopy,
  onReuse,
  onDetails,
}: Props) {
  if (message.state === MESSAGE_STATE.PENDING) return null;
  return (
    <div className="answer-actions">
      {message.state !== MESSAGE_STATE.COMPLETE && (
        <span className="answer-state" role="status">
          {message.state === MESSAGE_STATE.FAILED
            ? 'Response unavailable'
            : message.text
              ? 'Stopped · partial response'
              : 'Stopped'}
        </span>
      )}
      {message.text && (
        <IconButton
          label={copied ? 'Response copied' : 'Copy response'}
          onClick={onCopy}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
      )}
      {canReuse && (
        <IconButton
          label="Reuse question"
          disabled={reuseDisabled}
          onClick={onReuse}
        >
          <ArrowClockwise size={14} />
        </IconButton>
      )}
      <IconButton
        label="Response details"
        title="Response details"
        onClick={onDetails}
      >
        <Info size={14} />
      </IconButton>
    </div>
  );
}

export function ChatAnswer(props: Props) {
  const { message, run } = props;
  return (
    <article className="chat-answer" aria-label="Assistant">
      {message.state === MESSAGE_STATE.PENDING && (
        <AssistantProgress
          mark={
            <SignalMark
              state={
                run?.phase === CHAT_PHASE.CONNECTING
                  ? SIGNAL_STATE.CONNECTING
                  : run?.phase === CHAT_PHASE.TOOLS
                    ? SIGNAL_STATE.WORKING
                    : SIGNAL_STATE.RESPONDING
              }
            />
          }
        >
          <span>
            {message.paymentMethod === PAYMENT_METHOD.PAYPAL
              ? 'Generating response…'
              : run
                ? PHASE_LABEL[run.phase]
                : 'Preparing response'}
          </span>
        </AssistantProgress>
      )}
      {message.text ? (
        <MessageText text={message.text} />
      ) : message.state === MESSAGE_STATE.FAILED ? (
        <p className="stopped-note">
          The response could not be confirmed. Review its status in Payments.
        </p>
      ) : message.state === MESSAGE_STATE.STOPPED ? (
        <p className="stopped-note">Stopped before a response arrived.</p>
      ) : null}
      <AnswerActions {...props} />
    </article>
  );
}
