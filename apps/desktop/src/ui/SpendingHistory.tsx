import { useState, useSyncExternalStore } from 'react';

import { DEVNET_USDC } from '@gyblos/config/network';

import type { ActivityEntry } from '../activity-model';
import type { PaypalPaymentReference } from '../payment-reference-model';
import { type X402Record } from '../x402-model';
import type { ChatController } from './chat-controller';
import { FilterChips } from './FilterChips';
import {
  HISTORY,
  HISTORY_METHOD,
  HISTORY_PERIOD,
  HISTORY_SOURCE,
  type HistoryMethod,
  type HistoryPeriod,
  type HistorySource,
} from './history-constants';
import { filterHistory, referenceHeading } from './history-presentation';
import { HistorySummary } from './HistorySummary';
import { ChoiceMenu, Section } from './Management';
import { Pagination } from './Pagination';
import { ScrollTable } from './ScrollTable';
import { PaymentRow, UsdcPaymentRow } from './SpendingPaymentRows';
import type { ActivityView } from './useActivity';
import type { X402View } from './useX402';

type Props = {
  activity: ActivityView;
  buyer?: X402View;
  chat: ChatController;
  onActivity(id?: string): void;
  onChat(id: string): void;
};
type Entry =
  | { at: number; id: string; entry: ActivityEntry }
  | { at: number; id: string; record: X402Record };
function sourceFilter(entry: Entry, source: HistorySource) {
  if (source === HISTORY_SOURCE.ALL) return true;
  if ('record' in entry) return source === HISTORY_SOURCE.CHAT;
  return source === HISTORY_SOURCE.CHAT
    ? entry.entry.chatCount > 0 || entry.entry.chatCents > 0
    : entry.entry.agentCount > 0 || entry.entry.agentCents > 0;
}
function historyRows(
  { activity, buyer }: Props,
  method: HistoryMethod,
  period: HistoryPeriod,
) {
  const now = Date.now();
  const sessions = filterHistory(
    activity.state?.available ? activity.state.sessions : [],
    { now, method, period, source: HISTORY_SOURCE.ALL, query: '' },
  );
  const rows: Entry[] = sessions.map((entry) => ({
    id: 'paypal-' + entry.id,
    at: entry.updatedAt,
    entry,
  }));
  const after =
    period === HISTORY_PERIOD.ALL
      ? 0
      : now -
        HISTORY.DAY_MS *
          (period === HISTORY_PERIOD.WEEK
            ? HISTORY.WEEK_DAYS
            : HISTORY.MONTH_DAYS);
  if (method !== HISTORY_METHOD.PAYPAL && buyer?.state.summary.available) {
    for (const record of buyer.state.summary.records)
      if (
        record.at >= after &&
        (method !== HISTORY_METHOD.USDC || record.policy.mint === DEVNET_USDC)
      )
        rows.push({ id: 'usdc-' + record.id, at: record.at, record });
  }
  return rows.sort((left, right) => right.at - left.at);
}
export function SpendingHistory(props: Props) {
  const { activity, buyer, onActivity } = props;
  const { sessions } = useSyncExternalStore(
    props.chat.subscribe,
    props.chat.getSnapshot,
  );
  const conversations = new Map(
    sessions.flatMap((session) =>
      session.messages.map((message) => [message.id, session] as const),
    ),
  );
  const filters = useHistoryFilters(props);
  const { method, period, source, current, size, filtered, setPage, setSize } =
    filters;
  const references = activity.references.available
    ? activity.references.references
    : [];
  return (
    <Section title="Payment history">
      <HistoryFilters {...filters} />
      {method !== HISTORY_METHOD.USDC && !activity.state?.available && (
        <p role="status">
          {activity.state
            ? 'PayPal history unavailable.'
            : 'Loading PayPal history…'}
        </p>
      )}
      {method !== HISTORY_METHOD.PAYPAL && !buyer?.state.summary.available && (
        <p role="status">USDC history unavailable.</p>
      )}
      {source !== HISTORY_SOURCE.ALL && method !== HISTORY_METHOD.USDC && (
        <p className="ui-help-text">
          Amounts for shared PayPal sessions include all sources.
        </p>
      )}
      <HistoryTable
        rows={filtered.slice((current - 1) * size, current * size)}
        method={method}
        buyer={buyer}
        references={references}
        onActivity={onActivity}
        onChat={(id) => {
          const conversation = conversations.get(id + '-assistant');
          return conversation ? () => props.onChat(conversation.id) : undefined;
        }}
        resetKey={[source, method, period, current, size].join('|')}
      />
      {filtered.length >= HISTORY.PAGE_SIZES[0] && (
        <Pagination
          label="Payment pagination"
          total={filtered.length}
          page={current}
          pageSize={size}
          onPage={setPage}
          onPageSize={(n) => {
            setSize(n);
            setPage(1);
          }}
        />
      )}
      {method !== HISTORY_METHOD.USDC && activity.state?.available && (
        <details>
          <summary>PayPal spending summary</summary>
          <HistorySummary
            method={HISTORY_METHOD.PAYPAL}
            source={source}
            spending
            entries={filtered.flatMap((row) =>
              'entry' in row ? [row.entry] : [],
            )}
          />
        </details>
      )}
    </Section>
  );
}

function HistoryFilters({
  rows,
  source,
  method,
  period,
  setSource,
  setMethod,
  setPeriod,
}: {
  rows: Entry[];
  source: HistorySource;
  method: HistoryMethod;
  period: HistoryPeriod;
  setSource(v: HistorySource): void;
  setMethod(v: HistoryMethod): void;
  setPeriod(v: HistoryPeriod): void;
}) {
  return (
    <div className="ui-toolbar preview-history-filters">
      <FilterChips
        label="Usage source"
        value={source}
        options={Object.values(HISTORY_SOURCE).map((value) => ({
          value,
          label:
            value === HISTORY_SOURCE.ALL
              ? 'All'
              : value === HISTORY_SOURCE.AGENTS
                ? 'API'
                : 'Chat',
          count: rows.filter((row) => sourceFilter(row, value)).length,
        }))}
        onChange={setSource}
      />
      <ChoiceMenu
        label="Payment method"
        value={method}
        options={Object.values(HISTORY_METHOD)}
        onChange={setMethod}
      />
      <ChoiceMenu
        label="Period"
        value={period}
        options={Object.values(HISTORY_PERIOD)}
        onChange={setPeriod}
      />
    </div>
  );
}

function HistoryTable({
  rows,
  method,
  buyer,
  references,
  onActivity,
  onChat,
  resetKey,
}: {
  rows: Entry[];
  method: HistoryMethod;
  buyer?: X402View;
  references: readonly PaypalPaymentReference[];
  onActivity(id: string): void;
  onChat(id: string): (() => void) | undefined;
  resetKey: string;
}) {
  return (
    <ScrollTable
      regionLabel="Payment history table"
      caption="Locally recorded payments and authorizations"
      headings={[
        'Date',
        'Source',
        'Method',
        'Amount',
        'Status',
        referenceHeading(method),
        'Details',
      ]}
      resetKey={resetKey}
    >
      {rows.map((row) => {
        if ('entry' in row)
          return (
            <PaymentRow
              key={row.id}
              entry={row.entry}
              reference={references.find(
                (ref) => ref.sessionId === row.entry.id,
              )}
              method={method}
              onView={() => onActivity(row.entry.id)}
            />
          );

        return (
          buyer && (
            <UsdcPaymentRow
              key={row.id}
              record={row.record}
              buyer={buyer}
              onOpen={onChat(row.record.id)}
            />
          )
        );
      })}
      {!rows.length && (
        <tr>
          <td colSpan={7}>No matching records.</td>
        </tr>
      )}
    </ScrollTable>
  );
}

function useHistoryFilters(props: Props) {
  const [method, updateMethod] = useState<HistoryMethod>(HISTORY_METHOD.ALL);
  const [period, updatePeriod] = useState<HistoryPeriod>(HISTORY_PERIOD.MONTH);
  const [source, updateSource] = useState<HistorySource>(HISTORY_SOURCE.ALL);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(HISTORY.PAGE_SIZES[0]);
  const rows = historyRows(props, method, period);
  const filtered = rows.filter((row) => sourceFilter(row, source));
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / size)),
  );
  return {
    method,
    period,
    source,
    current,
    size,
    filtered,
    rows,
    setPage,
    setSize,
    setSource(value: HistorySource) {
      updateSource(value);
      setPage(1);
    },
    setMethod(value: HistoryMethod) {
      updateMethod(value);
      setPage(1);
    },
    setPeriod(value: HistoryPeriod) {
      updatePeriod(value);
      setPage(1);
    },
  };
}
