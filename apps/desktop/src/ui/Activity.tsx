// Reads consumption and payments without initiating financial work or showing stale totals.
import { useState, useSyncExternalStore } from 'react';

import type { ActivityEntry } from '../activity-model';
import type { PaypalPaymentReference } from '../payment-reference-model';
import { ActivitySessionDetails } from './ActivitySessionDetails';
import { ActivitySessions } from './ActivitySessions';
import type { ChatController } from './chat-controller';
import { BUTTON_VARIANT } from './constants';
import {
  FINANCIAL_TONE,
  HISTORY,
  HISTORY_METHOD,
  HISTORY_PERIOD,
  HISTORY_SOURCE,
  type HistoryMethod,
} from './history-constants';
import { filterHistory } from './history-presentation';
import { HistorySummary } from './HistorySummary';
import { ChoiceMenu, StatePanel } from './Management';
import { Pagination } from './Pagination';
import { Badge, Button, PagePanel, SearchField } from './UI';
import type { ActivityView } from './useActivity';
import type { X402View } from './useX402';
import { X402History } from './X402Payments';

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
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState<HistoryMethod>(HISTORY_METHOD.ALL);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(HISTORY.PAGE_SIZES[0]);
  const available = activity.state?.available === true;
  const entries = activity.state?.available ? activity.state.sessions : [];
  const references = activity.references.available
    ? activity.references.references
    : [];
  const visible = filterHistory(
    entries,
    {
      method,
      period: HISTORY_PERIOD.ALL,
      source: HISTORY_SOURCE.ALL,
      query,
      now: Date.now(),
    },
    references,
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(visible.length / pageSize)),
  );
  const selected = entries.find((entry) => entry.id === selectedSession);
  return (
    <PagePanel>
      {x402 && <X402History buyer={x402} />}
      <div className="ui-toolbar">
        <SearchField
          label="Search sessions"
          placeholder="Search sessions"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
        />
        <ChoiceMenu
          label="Payment method filter"
          value={method}
          options={Object.values(HISTORY_METHOD)}
          onChange={(value) => {
            setMethod(value);
            setPage(1);
          }}
        />
        <Button
          variant={BUTTON_VARIANT.SECONDARY}
          onClick={() => {
            void activity.refresh();
          }}
        >
          Refresh
        </Button>
        <Badge>Sandbox</Badge>
      </div>
      {available && <HistorySummary entries={visible} method={method} />}
      <ActivityResults
        activity={activity}
        available={available}
        entries={entries}
        visible={visible}
        references={references}
        method={method}
        query={query}
        currentPage={currentPage}
        pageSize={pageSize}
        onSelectSession={onSelectSession}
        setPage={setPage}
        setPageSize={setPageSize}
        onPayments={onPayments}
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

function ActivityResults({
  activity,
  available,
  entries,
  visible,
  references,
  method,
  query,
  currentPage,
  pageSize,
  onSelectSession,
  setPage,
  setPageSize,
  onPayments,
}: {
  activity: ActivityView;
  available: boolean;
  entries: ActivityEntry[];
  visible: ActivityEntry[];
  references: PaypalPaymentReference[];
  method: HistoryMethod;
  query: string;
  currentPage: number;
  pageSize: number;
  onSelectSession(id: string | null): void;
  setPage(page: number): void;
  setPageSize(size: number): void;
  onPayments(): void;
}) {
  if (!available) return <ActivityUnavailable activity={activity} />;
  return visible.length ? (
    <>
      <ActivitySessions
        entries={visible.slice(
          (currentPage - 1) * pageSize,
          currentPage * pageSize,
        )}
        references={references}
        method={method}
        resetKey={[currentPage, pageSize, query, method].join('|')}
        onSelect={onSelectSession}
      />
      <Pagination
        page={currentPage}
        pageSize={pageSize}
        total={visible.length}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </>
  ) : (
    <StatePanel
      title={entries.length ? 'No matching sessions' : 'No activity yet'}
      description={
        method === HISTORY_METHOD.USDC
          ? 'Verified x402 Chat payments are listed separately. Simulated chat replies are not payments.'
          : 'Chat and agent usage will appear here.'
      }
      action={<Button onClick={onPayments}>Go to Payments</Button>}
    />
  );
}

function ActivityUnavailable({ activity }: { activity: ActivityView }) {
  return activity.state === null ? (
    <StatePanel
      title="Loading activity…"
      description="Reading sessions and payments on this device."
      loading
    />
  ) : (
    <StatePanel
      title="Activity unavailable"
      tone={FINANCIAL_TONE.FAILED}
      description="Your local history could not be checked."
      action={
        <Button
          onClick={() => {
            void activity.refresh();
          }}
        >
          Try again
        </Button>
      }
    />
  );
}
