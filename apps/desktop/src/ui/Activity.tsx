import { useSyncExternalStore } from 'react';

import { ActivitySessionDetails } from './ActivitySessionDetails';
import { ActivitySessions } from './ActivitySessions';
import type { ChatController } from './chat-controller';
import { PagePanel } from './UI';
import type { ActivityView } from './useActivity';
import type { X402View } from './useX402';

type Props = {
  x402?: X402View;
  activity: ActivityView;
  chat: ChatController;
  onPayments(): void;
  onOpenChat(id: string): void;
  selectedSession: string | null;
  onSelectSession(id: string | null): void;
};
export function Activity({
  x402,
  activity,
  chat,
  onPayments,
  onOpenChat,
  selectedSession,
  onSelectSession,
}: Props) {
  const { sessions: conversations } = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
  );
  const entries = activity.state?.available ? activity.state.sessions : [];
  const selected = entries.find((entry) => entry.id === selectedSession);
  const references = activity.references.available
    ? activity.references.references
    : [];
  return (
    <PagePanel>
      <ActivitySessions
        conversations={conversations}
        activity={activity}
        x402={x402}
        onOpenChat={onOpenChat}
        onSelect={onSelectSession}
      />
      {selected && (
        <ActivitySessionDetails
          entry={selected}
          onCopyReference={() => activity.copyReference(selected.id)}
          reference={references.find((row) => row.sessionId === selected.id)}
          conversations={conversations}
          close={() => onSelectSession(null)}
          onOpenChat={onOpenChat}
          onPayments={onPayments}
          canReview={
            activity.state?.currentSessionId === selected.id ||
            activity.state?.currentSessionId === null
          }
        />
      )}
    </PagePanel>
  );
}
