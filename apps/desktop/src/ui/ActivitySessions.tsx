// Presents actual locally observed sessions in the shared, bounded table.
import type { ActivityEntry } from '../activity-model';
import { DESKTOP_ACTIVITY } from '../constants';
import type { PaypalPaymentReference } from '../payment-reference-model';
import { sessionOutcome } from './activity-presentation';
import { DataCell } from './DataTable';
import { type HistoryMethod } from './history-constants';
import {
  activityTone,
  historyDate,
  paymentAmount,
  referenceHeading,
} from './history-presentation';
import { FinancialValue } from './Management';
import { PaymentReference } from './PaymentReference';
import { ScrollTable } from './ScrollTable';
import { Button } from './UI';

export function ActivitySessions({
  entries,
  references,
  method,
  resetKey,
  onSelect,
}: {
  entries: ActivityEntry[];
  references: PaypalPaymentReference[];
  method: HistoryMethod;
  resetKey: string;
  onSelect(id: string): void;
}) {
  return (
    <ScrollTable
      caption="Session usage and confirmed payments observed on this device"
      headings={[
        'Session',
        'Chat',
        'Agents',
        'Usage',
        'Paid',
        referenceHeading(method),
        'Details',
      ]}
      resetKey={resetKey}
    >
      {entries.map((entry) => (
        <tr key={entry.id} role="row">
          <th scope="row">
            <strong>
              Session{' '}
              {entry.id.slice(0, DESKTOP_ACTIVITY.DISPLAY_ID_CHARACTERS)}
            </strong>
            <span className="activity-row-meta">
              PayPal · {historyDate(entry.firstObservedAt)}
            </span>
          </th>
          <DataCell label="Chat">
            {paymentAmount(entry.chatCents)}
            <span className="activity-row-meta">{entry.chatCount} replies</span>
          </DataCell>
          <DataCell label="Agents">
            {paymentAmount(entry.agentCents)}
            <span className="activity-row-meta">
              {entry.agentCount} inferences
            </span>
          </DataCell>
          <DataCell label="Usage">
            {paymentAmount(entry.recordedCents)}
          </DataCell>
          <DataCell label="Paid">
            <strong>
              {entry.capturedCents === null
                ? '—'
                : '− ' + paymentAmount(entry.capturedCents)}
            </strong>
            <span className="activity-row-meta">
              <FinancialValue tone={activityTone(entry)}>
                {sessionOutcome(entry)}
              </FinancialValue>
            </span>
          </DataCell>
          <DataCell label={referenceHeading(method)}>
            <PaymentReference
              reference={references.find((row) => row.sessionId === entry.id)}
            />
          </DataCell>
          <DataCell label="Details">
            <Button onClick={() => onSelect(entry.id)}>View</Button>
          </DataCell>
        </tr>
      ))}
    </ScrollTable>
  );
}
