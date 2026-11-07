// Shows recorded usage separately from successful captures; previews never enter money totals.
import type { ActivityEntry } from '../activity-model';
import { paypalDollars } from '../paypal-model';
import { StatCard } from './UI';

export function ActivityStats({ entries }: { entries: ActivityEntry[] }) {
  const recorded = entries.reduce(
    (total, entry) => total + entry.recordedCents,
    0,
  );
  const captured = entries.reduce(
    (total, entry) => total + (entry.capturedCents ?? 0),
    0,
  );
  const chatCents = entries.reduce(
    (total, entry) => total + entry.chatCents,
    0,
  );
  const agentCents = entries.reduce(
    (total, entry) => total + entry.agentCents,
    0,
  );
  const chatCount = entries.reduce(
    (total, entry) => total + entry.chatCount,
    0,
  );
  const agentCount = entries.reduce(
    (total, entry) => total + entry.agentCount,
    0,
  );
  const capturedCount = entries.filter(
    (entry) => entry.capturedCents !== null,
  ).length;
  return (
    <div className="ui-stats activity-stats">
      <StatCard
        label="Recorded usage"
        value={paypalDollars(recorded)}
        detail="PayPal Sandbox · test funds"
      />
      <StatCard
        label="Chat"
        value={paypalDollars(chatCents)}
        detail={`${chatCount} acknowledged replies`}
      />
      <StatCard
        label="Agents"
        value={paypalDollars(agentCents)}
        detail={`${agentCount} completed inferences`}
      />
      <StatCard
        label="Captured payments"
        value={paypalDollars(captured)}
        detail={`${capturedCount} captured ${capturedCount === 1 ? 'session' : 'sessions'}`}
      />
    </div>
  );
}
