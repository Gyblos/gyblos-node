import {
  ArrowUpRight,
  CurrencyCircleDollar,
  PaypalLogo,
} from '@phosphor-icons/react';

import { DEVNET_USDC } from '@gyblos/config/network';

import type { ActivityEntry } from '../activity-model';
import {
  X402_ACTION,
  x402Amount,
  x402Asset,
  x402Explorer,
  type X402Record,
} from '../x402-model';
import { sessionOutcome } from './activity-presentation';
import { DataCell } from './DataTable';
import {
  FINANCIAL_TONE,
  HISTORY_KIND,
  type HistoryMethod,
} from './history-constants';
import {
  historyDate,
  paymentAmount,
  referenceHeading,
  shortReference,
} from './history-presentation';
import { FinancialValue } from './Management';
import { PaymentReference } from './PaymentReference';
import { statusTone } from './status-tone';
import { Tag } from './Tag';
import { IconButton } from './UI';
import type { X402View } from './useX402';

export function UsdcPaymentRow({
  record,
  buyer,
  onOpen,
}: {
  record: X402Record;
  buyer: X402View;
  onOpen?(): void;
}) {
  const date = new Date(record.at);
  const status = record.free
    ? 'Free'
    : record.sessionApproval
      ? 'Channel approval'
      : 'Confirmed';
  return (
    <tr>
      <th scope="row">
        {Number.isFinite(date.getTime()) ? (
          <time dateTime={date.toISOString()}>{historyDate(record.at)}</time>
        ) : (
          'Date unavailable'
        )}
      </th>
      <DataCell label="Source">Chat</DataCell>
      <DataCell label="Method">
        <span className="preview-method">
          <CurrencyCircleDollar size={16} />
          {record.policy.mint === DEVNET_USDC ? 'USDC' : 'x402'}
        </span>
      </DataCell>
      <DataCell label="Amount">
        {record.free
          ? '0'
          : '− ' + x402Amount(record.chargeAtomic, record.policy)}{' '}
        {x402Asset(record.policy)}
      </DataCell>
      <DataCell label="Status">
        <Tag tone={statusTone(status)} dot>
          {status}
        </Tag>
        <small className="activity-row-meta">
          {record.selectedModel ?? record.policy.model}
        </small>
      </DataCell>
      <DataCell label="Payment ID">
        {record.transaction && !buyer.busy ? (
          <a
            href={x402Explorer(record.transaction)}
            aria-label="View transaction in explorer"
            onClick={(event) => {
              event.preventDefault();
              void buyer.run({ action: X402_ACTION.EXPLORER, id: record.id });
            }}
          >
            {shortReference(record.transaction)}
          </a>
        ) : (
          '—'
        )}
      </DataCell>
      <DataCell label="Details">
        {onOpen ? (
          <IconButton label="Open chat" onClick={onOpen}>
            <ArrowUpRight size={14} />
          </IconButton>
        ) : (
          '—'
        )}
      </DataCell>
    </tr>
  );
}
export function PaymentRow({
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
        <strong>{historyDate(entry.updatedAt)}</strong>
        <span className="activity-row-meta">
          {new Date(entry.updatedAt).getFullYear()}
        </span>
      </th>

      <DataCell label="Source">
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
      <DataCell label="Method">
        <span className="preview-method">
          <PaypalLogo size={16} />
          PayPal
        </span>
      </DataCell>
      <DataCell label="Amount">
        <FinancialValue
          tone={
            entry.needsReview ? FINANCIAL_TONE.PENDING : FINANCIAL_TONE.NEUTRAL
          }
        >
          {entry.capturedCents !== null
            ? '− ' + paymentAmount(entry.capturedCents)
            : paymentAmount(entry.recordedCents || entry.limitCents)}
        </FinancialValue>
        {kind === HISTORY_KIND.USAGE && (
          <span className="activity-row-meta">Recorded usage</span>
        )}
        {kind === HISTORY_KIND.AUTHORIZATION && (
          <span className="activity-row-meta">Session limit</span>
        )}
      </DataCell>
      <DataCell label="Status">
        <Tag dot tone={statusTone(sessionOutcome(entry))}>
          {sessionOutcome(entry)}
        </Tag>
      </DataCell>
      <DataCell label={referenceHeading(method)}>
        <PaymentReference reference={reference} />
      </DataCell>
      <DataCell label="Details">
        <IconButton label="View session details" onClick={onView}>
          <ArrowUpRight size={14} />
        </IconButton>
      </DataCell>
    </tr>
  );
}
