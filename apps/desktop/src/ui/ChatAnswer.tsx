// Presents a simulated chat response using shared message and control styles.
// Execution, clipboard state and session transitions remain with the caller.
import { ArrowClockwise, Check, Copy } from '@phosphor-icons/react';

import {
  CHAT_PHASE,
  MESSAGE_STATE,
  type ChatMessage,
  type ChatRun,
} from './chat-state';
import { AssistantHeading, AssistantProgress } from './ChatMessageParts';
import { MessageText } from './MessageText';
import { Badge, Button, IconButton } from './UI';

const PHASE_LABEL = {
  [CHAT_PHASE.CONNECTING]: 'Connecting to a provider',
  [CHAT_PHASE.TOOLS]: 'Using web tools',
  [CHAT_PHASE.RESPONDING]: 'Writing response',
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
  return (
    <div className="answer-actions">
      {message.state !== MESSAGE_STATE.PENDING && (
        <>
          <span className="answer-state" role="status">
            {message.state === MESSAGE_STATE.STOPPED
              ? message.text
                ? 'Stopped · partial response'
                : 'Stopped'
              : 'Completed'}
          </span>
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
        </>
      )}
      <Button onClick={onDetails}>Run details</Button>
    </div>
  );
}

export function ChatAnswer(props: Props) {
  const { message, run } = props;
  return (
    <article className="chat-answer" aria-label="Assistant">
      <AssistantHeading
        model={message.model.name}
        artwork={message.model.image}
        badge={<Badge>{message.model.free ? 'Free' : 'Paid'}</Badge>}
      />
      {message.state === MESSAGE_STATE.PENDING && (
        <AssistantProgress>
          <span>{run ? PHASE_LABEL[run.phase] : 'Preparing response'}</span>
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
