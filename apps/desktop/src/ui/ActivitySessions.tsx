import { ArrowUpRight, ChatCircle, Code, Stack } from '@phosphor-icons/react';
import { useState } from 'react';

import { DESKTOP_ACTIVITY } from '../constants';
import { PAYMENT_METHOD } from '../paypal-model';
import { X402_ACTION } from '../x402-model';
import type { ChatSession } from './chat-state';
import { CHAT_ROLE } from './constants';
import { DataCell, TableRow } from './DataTable';
import { HISTORY } from './history-constants';
import { historyDate } from './history-presentation';
import { ChoiceMenu, Section } from './Management';
import { Pagination } from './Pagination';
import { ScrollTable } from './ScrollTable';
import {
  Badge,
  Button,
  IconButton,
  SearchField,
  StatCard,
  StatGrid,
} from './UI';
import {
  measuredMetric,
  previousUsageTotals,
  USAGE_PERIOD,
  usageReport,
  type UsageEvent,
  type UsagePeriod,
  type UsageSource,
} from './usage-period';
import type { ActivityView } from './useActivity';
import type { X402View } from './useX402';

const numbers = new Intl.NumberFormat();
const dates = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function ActivitySessions({
  conversations,
  activity,
  x402,
  onOpenChat,
  onSelect,
}: {
  conversations: ChatSession[];
  activity: ActivityView;
  x402?: X402View;
  onOpenChat(id: string): void;
  onSelect(id: string): void;
}) {
  const [source, setSource] = useState<'All sources' | UsageSource>(
    'All sources',
  );
  const [period, setPeriod] = useState<UsagePeriod>(USAGE_PERIOD.MONTH);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(HISTORY.PAGE_SIZES[0]);
  const events: UsageEvent[] = [];
  const byMessage = new Map(
    conversations.flatMap((chat) =>
      chat.messages
        .filter(
          (message) =>
            message.role === CHAT_ROLE.ASSISTANT &&
            message.paymentMethod === PAYMENT_METHOD.USDC,
        )
        .map(
          (message) =>
            [message.id, { chat, metrics: message.metrics }] as const,
        ),
    ),
  );
  for (const record of x402?.state.summary.available
    ? x402.state.summary.records
    : []) {
    const match = byMessage.get(record.id + '-assistant');
    const metrics = match?.metrics;
    events.push({
      id: 'usdc-' + (match?.chat.id ?? record.sessionId),
      title: match?.chat.title ?? record.policy.model,
      at: record.at,
      source: 'Chat',
      tokens:
        metrics?.inputTokens != null && metrics.outputTokens != null
          ? metrics.inputTokens + metrics.outputTokens
          : null,
      ...(match && { open: () => onOpenChat(match.chat.id) }),
    });
  }
  for (const session of period === USAGE_PERIOD.ALL && activity.state?.available
    ? activity.state.sessions
    : []) {
    const append = (source: UsageSource, count: number) => {
      if (count)
        events.push({
          id: session.id,
          title:
            'Session ' +
            session.id.slice(0, DESKTOP_ACTIVITY.DISPLAY_ID_CHARACTERS),
          source,
          count,
          at: session.updatedAt,
          tokens: null,
          open: () => onSelect(session.id),
        });
    };
    append('Chat', session.chatCount);
    append('API', session.agentCount);
  }
  const now = Date.now();
  const { rows, start, totals } = usageReport(events, period, now);
  const previous = previousUsageTotals(events, period, now);
  const apiAvailable =
    period === USAGE_PERIOD.ALL && activity.state?.available === true;
  const chatAvailable =
    (period !== USAGE_PERIOD.ALL || apiAvailable) &&
    x402?.state.summary.available === true;
  const count = totals.Chat + totals.API;
  const needle = query.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      (source === 'All sources' || row.source === source) &&
      row.title.toLowerCase().includes(needle),
  );
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / size)),
  );
  return (
    <Section
      title="Usage history"
      action={
        <ChoiceMenu
          label="Usage period"
          options={Object.values(USAGE_PERIOD)}
          value={period}
          onChange={(value) => {
            const next = Object.values(USAGE_PERIOD).find(
              (period) => period === value,
            );
            if (next) setPeriod(next);
            setPage(1);
          }}
        />
      }
    >
      <div className="preview-usage-overview">
        <p className="ui-help-text">
          {period === USAGE_PERIOD.ALL
            ? 'All recorded dates'
            : start === new Date(now).setHours(0, 0, 0, 0)
              ? dates.format(now)
              : dates.format(start) + ' – ' + dates.format(now)}
        </p>
        <StatGrid>
          <StatCard
            label="Tokens used"
            help="Measured input and output tokens for locally recorded requests."
            icon={Stack}
            {...measuredMetric(
              chatAvailable,
              count && !totals.measured ? null : totals.tokens,
              previous &&
                previous.measured === previous.Chat + previous.API &&
                totals.measured === count
                ? previous.tokens
                : null,
            )}
          />
          <StatCard
            label="Chat requests"
            help="Dated USDC records in this period. All time also includes PayPal session totals."
            icon={ChatCircle}
            {...measuredMetric(
              chatAvailable,
              totals.Chat,
              previous?.Chat ?? null,
            )}
          />
          <StatCard
            label="Recorded API requests"
            help="PayPal reports lifetime session counts. Select All time to see recorded API requests."
            icon={Code}
            {...measuredMetric(apiAvailable, totals.API, previous?.API ?? null)}
          />
        </StatGrid>
        {totals.measured < count && (
          <small className="ui-help-text">
            Token counts available for {numbers.format(totals.measured)} of{' '}
            {numbers.format(count)} requests.
          </small>
        )}
      </div>
      <div className="ui-toolbar">
        <SearchField
          label="Search activity"
          placeholder="Search chats or sessions"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
        />
        <ChoiceMenu
          label="Usage source"
          options={['All sources', 'Chat', 'API']}
          value={source}
          onChange={(value) => {
            if (value === 'Chat' || value === 'API' || value === 'All sources')
              setSource(value);
            setPage(1);
          }}
        />
        <Button
          disabled={x402?.busy}
          onClick={() => {
            void x402?.run({ action: X402_ACTION.STATUS });
            void activity.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {activity.state && !activity.state.available && (
        <p role="status">Session usage is unavailable.</p>
      )}
      <ScrollTable
        regionLabel="Usage history table"
        caption="Recorded chat replies and API requests"
        headings={[
          'Chat or session',
          'Source',
          'Requests',
          'Tokens',
          'Last activity',
          'Details',
        ]}
        resetKey={[query, source, period, current, size].join('|')}
      >
        {filtered.slice((current - 1) * size, current * size).map((row) => (
          <TableRow key={row.source + row.id}>
            <th scope="row">
              <span className="preview-chat-title" title={row.title}>
                {row.title}
              </span>
            </th>
            <DataCell label="Source">
              <Badge>{row.source}</Badge>
            </DataCell>
            <DataCell label="Requests">{numbers.format(row.count)}</DataCell>
            <DataCell label="Tokens">
              {row.measured ? numbers.format(row.tokens) : '—'}
            </DataCell>
            <DataCell label="Last activity">{historyDate(row.at)}</DataCell>
            <DataCell label="Details">
              {row.open ? (
                <IconButton
                  title="View details"
                  label={'View ' + row.title}
                  onClick={row.open}
                >
                  <ArrowUpRight size={14} />
                </IconButton>
              ) : (
                '—'
              )}
            </DataCell>
          </TableRow>
        ))}
        {!filtered.length && (
          <TableRow>
            <td colSpan={6}>
              {activity.state === null
                ? 'Loading activity…'
                : 'No matching activity.'}
            </td>
          </TableRow>
        )}
      </ScrollTable>
      {filtered.length >= HISTORY.PAGE_SIZES[0] && (
        <Pagination
          label="Usage pagination"
          page={current}
          pageSize={size}
          total={filtered.length}
          onPage={setPage}
          onPageSize={(value) => {
            setSize(value);
            setPage(1);
          }}
        />
      )}
    </Section>
  );
}
