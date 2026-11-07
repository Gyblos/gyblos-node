// Presents local consumption and payment outcomes without initiating financial work.
import { ChatCircle, CreditCard } from '@phosphor-icons/react';
import { useSyncExternalStore } from 'react';

import { activityDate } from './activity-presentation';
import { ActivitySessionDetails } from './ActivitySessionDetails';
import { ActivitySessions } from './ActivitySessions';
import { ActivityStats } from './ActivityStats';
import type { ChatController } from './chat-controller';
import { conversationSummary } from './chat-history';
import type { ChatSession } from './chat-state';
import { BUTTON_VARIANT } from './constants';
import {
  Badge,
  Button,
  EmptyState,
  List,
  ListRow,
  Note,
  PagePanel,
  RowCopy,
  SectionTitle,
} from './UI';
import type { ActivityView } from './useActivity';

type Props = {
  activity: ActivityView;
  chat: ChatController;
  onPayments(): void;
  onOpenChat(id: string): void;
  selectedSession: string | null;
  onSelectSession(id: string | null): void;
};
export function Activity({
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
  const entries = activity.state?.sessions ?? [];
  const selected = entries.find((entry) => entry.id === selectedSession);
  return (
    <PagePanel>
      <div className="activity-heading">
        <div>
          <h2>Activity</h2>
          <p>Consumption and payments, session by session.</p>
        </div>
        <Button
          variant={BUTTON_VARIANT.SECONDARY}
          onClick={() => {
            void activity.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {activity.state === null ? (
        <Note>Loading activity…</Note>
      ) : (
        <>
          {!activity.state.available && (
            <Note>
              History is incomplete: local storage could not be read or saved.
              Visible totals cover only the records available here. Review
              Payments for the current session.
            </Note>
          )}
          <ActivityStats entries={entries} />
          <SectionTitle trailing={<Badge>Test funds</Badge>}>
            PayPal sessions
          </SectionTitle>
          {entries.length ? (
            <ActivitySessions entries={entries} onSelect={onSelectSession} />
          ) : (
            <NoPaypalActivity onPayments={onPayments} />
          )}
        </>
      )}
      <PreviewActivity conversations={conversations} onOpenChat={onOpenChat} />
      {selectedSession && !selected && activity.state !== null && (
        <Note>
          This session is not available in the local payment history.{' '}
          <Button onClick={() => onSelectSession(null)}>
            Show all sessions
          </Button>
        </Note>
      )}
      {selected && (
        <ActivitySessionDetails
          entry={selected}
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
function PreviewActivity({
  conversations,
  onOpenChat,
}: {
  conversations: ChatSession[];
  onOpenChat(id: string): void;
}) {
  const previews = conversations
    .map((session) => ({ session, summary: conversationSummary(session) }))
    .filter((item) => item.summary.previewReplies > 0);
  return (
    <>
      <SectionTitle trailing={<Badge>Simulated · no payment</Badge>}>
        USDC preview
      </SectionTitle>
      <List label="USDC preview conversations">
        {previews.map(({ session, summary }) => (
          <ListRow
            key={session.id}
            leading={<ChatCircle size={18} />}
            onActivate={() => onOpenChat(session.id)}
            trailing={<Badge>{summary.previewReplies} simulated replies</Badge>}
          >
            <RowCopy
              title={session.title}
              detail={
                summary.lastSentAt === null
                  ? 'Time unavailable'
                  : activityDate(summary.lastSentAt)
              }
            />
          </ListRow>
        ))}
        {!previews.length && (
          <p className="ui-list-empty">No saved preview replies.</p>
        )}
      </List>
    </>
  );
}

function NoPaypalActivity({ onPayments }: { onPayments(): void }) {
  return (
    <div>
      <EmptyState
        icon={<CreditCard size={24} />}
        title="No recorded PayPal sessions"
        description="Authorize a session in Payments. Chat and Agents will share its limit and appear here."
      />
      <Button variant={BUTTON_VARIANT.SECONDARY} onClick={onPayments}>
        Go to Payments
      </Button>
    </div>
  );
}
