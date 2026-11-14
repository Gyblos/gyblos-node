// Keeps source usage, payment outcome and linked conversations distinct in a flat dialog.
import {
  ArrowRight,
  ChatCircle,
  CreditCard,
  Robot,
} from '@phosphor-icons/react';

import type { ActivityEntry } from '../activity-model';
import { DESKTOP_ACTIVITY } from '../constants';
import type { PaypalPaymentReference } from '../payment-reference-model';
import { paypalDollars } from '../paypal-model';
import { activityDate, sessionOutcome } from './activity-presentation';
import { conversationSummary } from './chat-history';
import type { ChatSession } from './chat-state';
import { BUTTON_VARIANT } from './constants';
import { Modal } from './Modal';
import { PaymentReferenceDetails } from './PaymentReference';
import {
  Badge,
  Button,
  List,
  ListRow,
  Note,
  RowCopy,
  SectionTitle,
  StatCard,
} from './UI';

type Props = {
  entry: ActivityEntry;
  reference?: PaypalPaymentReference;
  onCopyReference(): Promise<boolean>;
  conversations: ChatSession[];
  close(): void;
  onOpenChat(id: string): void;
  onPayments(): void;
  canReview: boolean;
};
export function ActivitySessionDetails({
  entry,
  reference,
  onCopyReference,
  conversations,
  close,
  onOpenChat,
  onPayments,
  canReview,
}: Props) {
  return (
    <Modal
      title={`Session ${entry.id.slice(0, DESKTOP_ACTIVITY.DISPLAY_ID_CHARACTERS)}`}
      close={close}
    >
      <div className="activity-heading">
        <Badge>PayPal Sandbox · test funds</Badge>
        <Badge>{sessionOutcome(entry)}</Badge>
      </div>
      <div className="ui-stats activity-breakdown">
        <StatCard
          label="Chat"
          value={paypalDollars(entry.chatCents)}
          detail={`${entry.chatCount} acknowledged replies`}
        />
        <StatCard
          label="Agents"
          value={paypalDollars(entry.agentCents)}
          detail={`${entry.agentCount} completed inferences`}
        />
      </div>
      <SessionPayment entry={entry} />
      <PaymentReferenceDetails reference={reference} copy={onCopyReference} />
      {entry.needsReview && (
        <Note>
          An unfinished operation needs review. An uncertain inference may be
          outside the recorded total. Activity never retries a payment.
        </Note>
      )}
      <LinkedConversations
        conversations={conversations}
        sessionId={entry.id}
        onOpen={(id) => {
          close();
          onOpenChat(id);
        }}
      />
      <p className="activity-footnote">
        Shared session totals can include several conversations and agents. Last
        recorded on this device: {activityDate(entry.updatedAt)}.
      </p>
      {canReview && (
        <Button
          variant={BUTTON_VARIANT.SECONDARY}
          onClick={() => {
            close();
            onPayments();
          }}
        >
          Review in Payments
        </Button>
      )}
    </Modal>
  );
}
function SessionPayment({ entry }: { entry: ActivityEntry }) {
  return (
    <List label="Session payment summary">
      <ListRow
        leading={<CreditCard size={18} />}
        trailing={paypalDollars(entry.limitCents)}
      >
        <RowCopy title="Session limit" detail="Maximum requested" />
      </ListRow>
      <ListRow
        leading={<Robot size={18} />}
        trailing={paypalDollars(entry.recordedCents)}
      >
        <RowCopy
          title="Recorded consumption"
          detail={
            entry.unconfirmedCents
              ? `${paypalDollars(entry.unconfirmedCents)} awaiting confirmation`
              : 'Chat and Agents combined'
          }
        />
      </ListRow>
      <ListRow
        leading={<CreditCard size={18} />}
        trailing={
          entry.capturedCents === null
            ? 'Not confirmed'
            : paypalDollars(entry.capturedCents)
        }
      >
        <RowCopy title="Captured payment" detail={sessionOutcome(entry)} />
      </ListRow>
    </List>
  );
}
function LinkedConversations({
  conversations,
  sessionId,
  onOpen,
}: {
  conversations: ChatSession[];
  sessionId: string;
  onOpen(id: string): void;
}) {
  const linked = conversations.filter((item) =>
    conversationSummary(item).paymentSessionIds.includes(sessionId),
  );
  return (
    <>
      <SectionTitle>Linked conversations</SectionTitle>
      <List label="Linked conversations">
        {linked.map((item) => (
          <ListRow
            key={item.id}
            leading={<ChatCircle size={18} />}
            onActivate={() => onOpen(item.id)}
            trailing={<ArrowRight size={16} />}
          >
            <RowCopy title={item.title} detail="Open conversation" />
          </ListRow>
        ))}
        {!linked.length && (
          <p className="ui-list-empty">
            No linked conversations saved on this device. Agent usage and
            earlier replies remain in the session totals.
          </p>
        )}
      </List>
    </>
  );
}
