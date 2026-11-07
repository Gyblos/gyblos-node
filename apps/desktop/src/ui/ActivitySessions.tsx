// Lists session-level usage without treating an authorization or consumption as a payment.
import { ArrowRight } from '@phosphor-icons/react';
import { useState } from 'react';

import type { ActivityEntry } from '../activity-model';
import { DESKTOP_ACTIVITY } from '../constants';
import { paypalDollars } from '../paypal-model';
import { activityDate, sessionOutcome } from './activity-presentation';
import { DataCell, DataTable } from './DataTable';
import { Button, SearchField } from './UI';

export function ActivitySessions({
  entries,
  onSelect,
}: {
  entries: ActivityEntry[];
  onSelect(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const ordered = [...entries].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const visible = ordered.filter((entry) =>
    `${entry.id} ${sessionOutcome(entry)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <SearchField
        label="Search sessions"
        value={query}
        onValueChange={setQuery}
        placeholder="Session or status…"
      />
      <DataTable
        caption="Recorded consumption and captured payments for locally observed PayPal Sandbox sessions"
        headings={['Session', 'Chat', 'Agents', 'Recorded', 'Payment']}
      >
        {visible.map((entry) => (
          <SessionRow key={entry.id} entry={entry} onSelect={onSelect} />
        ))}
      </DataTable>
      {!visible.length && (
        <p className="ui-list-empty">No sessions match your search.</p>
      )}
      <p className="activity-footnote">
        Recorded usage is consumption, not a payment. Capture is shown only
        after Gyblos records a successful capture. Dates show when this device
        observed a session; earlier sessions may be unavailable.
      </p>
    </>
  );
}
function SessionRow({
  entry,
  onSelect,
}: {
  entry: ActivityEntry;
  onSelect(id: string): void;
}) {
  return (
    <tr role="row">
      <th scope="row" role="rowheader">
        <Button onClick={() => onSelect(entry.id)} title="View session details">
          Session {entry.id.slice(0, DESKTOP_ACTIVITY.DISPLAY_ID_CHARACTERS)}
          <ArrowRight size={14} />
        </Button>
        <span className="activity-row-meta">
          Observed {activityDate(entry.firstObservedAt)}
        </span>
      </th>
      <DataCell label="Chat">
        {paypalDollars(entry.chatCents)}
        <span className="activity-row-meta">{entry.chatCount} replies</span>
      </DataCell>
      <DataCell label="Agents">
        {paypalDollars(entry.agentCents)}
        <span className="activity-row-meta">{entry.agentCount} inferences</span>
      </DataCell>
      <DataCell label="Recorded">
        {paypalDollars(entry.recordedCents)}
        {entry.unconfirmedCents > 0 && (
          <span className="activity-row-meta">
            {paypalDollars(entry.unconfirmedCents)} unconfirmed
          </span>
        )}
      </DataCell>
      <DataCell label="Payment">
        <strong>
          {entry.capturedCents === null
            ? '—'
            : paypalDollars(entry.capturedCents)}
        </strong>
        <span className="activity-row-meta">{sessionOutcome(entry)}</span>
      </DataCell>
    </tr>
  );
}
