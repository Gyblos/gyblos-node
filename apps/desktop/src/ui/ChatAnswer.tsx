// Presents a response on the shared reading surface with the Gyblos generation signal.
// Execution, clipboard state and session transitions remain with the caller.
import { ArrowClockwise, Check, Copy, Info } from '@phosphor-icons/react';

import {
  CHAT_PHASE,
  MESSAGE_STATE,
  type ChatMessage,
  type ChatRun,
} from './chat-state';
import { AssistantProgress } from './ChatMessageParts';
import { MessageText } from './MessageText';
import { SIGNAL_STATE } from './Signal';
import { SignalFace } from './SignalFace';
import { TurnActivity } from './TurnActivity';
import { IconButton } from './UI';

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
          {message.text ? 'Stopped · partial response' : 'Stopped'}
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
    <article
      className="chat-answer"
      aria-label="Assistant"
      data-streaming={
        (message.state === MESSAGE_STATE.PENDING && !!message.text) || undefined
      }
    >
      {message.activity && (
        <TurnActivity
          timing={message.activity}
          state={message.state}
          hasText={!!message.text}
        />
      )}
      {!message.activity && message.state === MESSAGE_STATE.PENDING && (
        <AssistantProgress
          mark={
            <SignalFace
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
          {run?.phase === CHAT_PHASE.TOOLS
            ? 'Using tools…'
            : run?.phase === CHAT_PHASE.CONNECTING
              ? 'Connecting…'
              : message.text || run?.phase === CHAT_PHASE.RESPONDING
                ? 'Writing…'
                : 'Preparing response'}
        </AssistantProgress>
      )}
      {message.text ? (
        <MessageText text={message.text} />
      ) : message.state === MESSAGE_STATE.STOPPED ? (
        <p className="stopped-note">Stopped before a response arrived.</p>
      ) : null}
      <AnswerActions {...props} />
    </article>
  );
}
