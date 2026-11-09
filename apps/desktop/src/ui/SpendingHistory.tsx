// Filters actual provider observations; USDC has no transaction source in this desktop version.
import { useState } from 'react';

import type { ActivityEntry } from '../activity-model';
import type { PaypalPaymentReference } from '../payment-reference-model';
import { paypalDollars } from '../paypal-model';
import { activityDate, sessionOutcome } from './activity-presentation';
import { DataCell } from './DataTable';
import {
  FINANCIAL_TONE,
  HISTORY,
  HISTORY_KIND,
  HISTORY_METHOD,
  HISTORY_PERIOD,
  HISTORY_SOURCE,
  type HistoryMethod,
  type HistoryPeriod,
  type HistorySource,
} from './history-constants';
import { filterHistory, referenceHeading } from './history-presentation';
import { HistorySummary } from './HistorySummary';
import { ChoiceMenu, FinancialValue, Section, StatePanel } from './Management';
import { Pagination } from './Pagination';
import { PaymentReference } from './PaymentReference';
import { ScrollTable } from './ScrollTable';
import { Button } from './UI';
import type { ActivityView } from './useActivity';

type Props = { activity: ActivityView; onActivity(id?: string): void };
export function SpendingHistory({ activity, onActivity }: Props) {
  const [method, setMethod] = useState<HistoryMethod>(HISTORY_METHOD.USDC);
  const [period, setPeriod] = useState<HistoryPeriod>(HISTORY_PERIOD.MONTH);
  const [source, setSource] = useState<HistorySource>(HISTORY_SOURCE.ALL);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(HISTORY.PAGE_SIZES[0]);
  const references = activity.references.available
    ? activity.references.references
    : [];
  const rows = filterHistory(
    activity.state?.available ? activity.state.sessions : [],
    { method, period, source, query: '', now: Date.now() },
    references,
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  return (
    <>
      <Section title="Spending">
        <SpendingFilters
          period={period}
          setPeriod={setPeriod}
          method={method}
          setMethod={setMethod}
          source={source}
          setSource={setSource}
          setPage={setPage}
        />
        {activity.state?.available && (
          <HistorySummary
            entries={rows}
            method={method}
            source={source}
            spending
          />
        )}
      </Section>
      <Section
        title="Payment history"
        action={<Button onClick={() => onActivity()}>View activity</Button>}
      >
        <PaymentHistoryResults
          activity={activity}
          rows={rows}
          references={references}
          method={method}
          period={period}
          source={source}
          currentPage={currentPage}
          pageSize={pageSize}
          onActivity={onActivity}
          setPage={setPage}
          setPageSize={setPageSize}
        />
      </Section>
    </>
  );
}
function PaymentRow({
  entry,
  reference,
  method,
  onView,
}: {
  entry: ActivityEntry;
  reference: Parameters<typeof PaymentReference>[0]['reference'];
  method: HistoryMethod;
  onView(): void;
}) {
  const kind =
    entry.capturedCents !== null
      ? HISTORY_KIND.PAYMENT
      : entry.recordedCents > 0
        ? HISTORY_KIND.USAGE
        : HISTORY_KIND.AUTHORIZATION;
  return (
    <tr>
      <th scope="row">
        <strong>{activityDate(entry.updatedAt)}</strong>
        <span className="activity-row-meta">Observed on this device</span>
      </th>
      <DataCell label="Method">PayPal</DataCell>
      <DataCell label="Type">
        {kind}
        <span className="activity-row-meta">
          {entry.chatCount && entry.agentCount
            ? 'Chat + Agents'
            : entry.chatCount
              ? 'Chat'
              : entry.agentCount
                ? 'Agents'
                : '—'}
        </span>
      </DataCell>
      <DataCell label="Amount">
        <FinancialValue
          tone={
            entry.needsReview ? FINANCIAL_TONE.PENDING : FINANCIAL_TONE.NEUTRAL
          }
        >
          {entry.capturedCents !== null
            ? '− ' + paypalDollars(entry.capturedCents)
            : paypalDollars(entry.recordedCents || entry.limitCents)}
        </FinancialValue>
        {kind === HISTORY_KIND.AUTHORIZATION && (
          <span className="activity-row-meta">Session limit</span>
        )}
      </DataCell>
      <DataCell label="Status">
        <FinancialValue
          tone={
            entry.needsReview ? FINANCIAL_TONE.PENDING : FINANCIAL_TONE.NEUTRAL
          }
        >
          {sessionOutcome(entry)}
        </FinancialValue>
      </DataCell>
      <DataCell label={referenceHeading(method)}>
        <PaymentReference reference={reference} />
      </DataCell>
      <DataCell label="Details">
        <Button onClick={onView}>View</Button>
      </DataCell>
    </tr>
  );
}

function SpendingFilters({
  period,
  setPeriod,
  method,
  setMethod,
  source,
  setSource,
  setPage,
}: {
  period: HistoryPeriod;
  setPeriod(value: HistoryPeriod): void;
  method: HistoryMethod;
  setMethod(value: HistoryMethod): void;
  source: HistorySource;
  setSource(value: HistorySource): void;
  setPage(page: number): void;
}) {
  return (
    <div className="ui-toolbar ui-spending-filters">
      <div className="ui-field">
        <span>Period</span>
        <ChoiceMenu
          label="Spending period"
          value={period}
          options={Object.values(HISTORY_PERIOD)}
          onChange={(value) => {
            setPeriod(value);
            setPage(1);
          }}
        />
      </div>
      <div className="ui-field">
        <span>Payment method</span>
        <ChoiceMenu
          label="Spending payment method"
          value={method}
          options={Object.values(HISTORY_METHOD)}
          onChange={(value) => {
            setMethod(value);
            setPage(1);
          }}
        />
      </div>
      <div className="ui-field">
        <span>Usage source</span>
        <ChoiceMenu
          label="Spending usage source"
          value={source}
          options={Object.values(HISTORY_SOURCE)}
          onChange={(value) => {
            setSource(value);
            setPage(1);
          }}
        />
      </div>
    </div>
  );
}

function PaymentHistoryResults({
  activity,
  rows,
  references,
  method,
  period,
  source,
  currentPage,
  pageSize,
  onActivity,
  setPage,
  setPageSize,
}: {
  activity: ActivityView;
  rows: ActivityEntry[];
  references: PaypalPaymentReference[];
  method: HistoryMethod;
  period: HistoryPeriod;
  source: HistorySource;
  currentPage: number;
  pageSize: number;
  onActivity(id?: string): void;
  setPage(page: number): void;
  setPageSize(size: number): void;
}) {
  if (!activity.state?.available)
    return <PaymentHistoryState activity={activity} />;
  return rows.length ? (
    <>
      <div className="ui-payment-history">
        <ScrollTable
          regionLabel="Payment history table"
          caption="Latest locally observed payment and authorization outcome per session"
          headings={[
            'Date',
            'Method',
            'Type',
            'Amount',
            'Status',
            referenceHeading(method),
            'Details',
          ]}
          resetKey={[currentPage, pageSize, period, method, source].join('|')}
        >
          {rows
            .slice((currentPage - 1) * pageSize, currentPage * pageSize)
            .map((row) => (
              <PaymentRow
                key={row.id}
                entry={row}
                reference={references.find((item) => item.sessionId === row.id)}
                method={method}
                onView={() => onActivity(row.id)}
              />
            ))}
        </ScrollTable>
      </div>
      <Pagination
        label="Payment pagination"
        page={currentPage}
        pageSize={pageSize}
        total={rows.length}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </>
  ) : (
    <StatePanel
      title="No payments to show"
      description={
        method === HISTORY_METHOD.USDC
          ? 'USDC transaction history is not available in this version.'
          : 'No sessions match these filters.'
      }
    />
  );
}

function PaymentHistoryState({ activity }: { activity: ActivityView }) {
  return activity.state === null ? (
    <StatePanel
      title="Loading payments…"
      description="Reading local payment records."
      loading
    />
  ) : (
    <StatePanel
      title="Payment history unavailable"
      description="Check local history before relying on totals."
      tone={FINANCIAL_TONE.FAILED}
    />
  );
}
