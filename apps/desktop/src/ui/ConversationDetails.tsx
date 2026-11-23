import { X } from '@phosphor-icons/react';
import { useSyncExternalStore } from 'react';

import { RESPONSE_METRICS } from '../constants';
import type { ChatController } from './chat-controller';
import { CHAT_ROLE } from './constants';
import { Facts, Pair } from './Management';
import { IconButton } from './UI';

export function ConversationDetails({
  chat,
  close,
}: {
  chat: ChatController;
  close(): void;
}) {
  const { sessions, activeId } = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
  );
  const session = sessions.find((item) => item.id === activeId);
  const answers =
    session?.messages.filter(
      (message) => message.role === CHAT_ROLE.ASSISTANT,
    ) ?? [];
  const last = answers.at(-1);
  const times = answers.flatMap((message) =>
    message.metrics?.responseMs == null ? [] : [message.metrics.responseMs],
  );
  const tokens = answers.map((message) => message.metrics);
  const complete =
    tokens.length > 0 &&
    tokens.every(
      (item) => item?.inputTokens != null && item?.outputTokens != null,
    );
  const cost = last?.metrics?.cost;
  return (
    <aside
      className="ui-context-panel preview-chat-details"
      aria-label="Conversation details"
    >
      <header className="ui-context-heading">
        <h2>Details</h2>
        <IconButton label="Close details" onClick={close}>
          <X size={16} />
        </IconButton>
      </header>
      {!session?.messages.length ? (
        <p className="ui-help-text">
          Send a message to see its model and usage.
        </p>
      ) : (
        <Facts compact>
          <Pair label="Model" value={last?.model.name ?? '—'} />
          <Pair label="Messages" value={String(session.messages.length)} />
          <Pair
            label="Tokens"
            value={
              complete
                ? tokens
                    .reduce(
                      (sum, metrics) => sum + (metrics?.inputTokens ?? 0),
                      0,
                    )
                    .toLocaleString() +
                  ' in · ' +
                  tokens
                    .reduce(
                      (sum, metrics) => sum + (metrics?.outputTokens ?? 0),
                      0,
                    )
                    .toLocaleString() +
                  ' out'
                : '—'
            }
          />
          <Pair
            label="Last response cost"
            value={cost ? cost.amount + ' ' + cost.unit : '—'}
          />
          <Pair
            label="Avg. measured response"
            value={
              times.length
                ? (
                    times.reduce((total, time) => total + time, 0) /
                    times.length /
                    RESPONSE_METRICS.MS_PER_SECOND
                  ).toFixed(1) + ' s'
                : '—'
            }
          />
        </Facts>
      )}
    </aside>
  );
}
