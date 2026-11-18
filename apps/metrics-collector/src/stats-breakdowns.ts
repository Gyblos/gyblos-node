// Owns the public shape of the network breakdowns: requests by the buyer application that reported
// them, and failures by side, application, event and reason. A row with fewer distinct buyers than
// AGGREGATES.minPublicBuyers is withheld: its label stays, every number is null.
import { publicBuyers } from './stats-shape';
import type { FailureRow, OriginRow } from './stats-store';

export interface OriginEntry {
  // buyer-desktop, buyer-cli, or unknown (only the seller reported the request).
  client: string;
  paid: boolean;
  buyers: number | null;
  withheld: boolean;
  // Headline requests (bilateral plus seller-only); null when withheld.
  requests: number | null;
  outcomes: { completed: number; failed: number; cancelled: number } | null;
}
export interface FailureEntry {
  // The side that reported it (buyer or seller) and its application.
  side: string;
  client: string;
  // failed, refused or unserved.
  event: string;
  // A failure's stop reason or code, a refusal's kind, or none.
  reason: string;
  buyers: number | null;
  withheld: boolean;
  events: number | null;
}

export function originEntry(row: OriginRow): OriginEntry {
  const shown = publicBuyers(row.buyers);
  return {
    client: row.clientKind,
    paid: row.paid === 1,
    ...shown,
    requests: shown.withheld ? null : row.requests,
    outcomes: shown.withheld
      ? null
      : {
          completed: row.completed,
          failed: row.failed,
          cancelled: row.cancelled,
        },
  };
}

export function failureEntry(row: FailureRow): FailureEntry {
  const shown = publicBuyers(row.buyers);
  return {
    side: row.side,
    client: row.clientKind,
    event: row.event,
    reason: row.reason,
    ...shown,
    events: shown.withheld ? null : row.events,
  };
}
