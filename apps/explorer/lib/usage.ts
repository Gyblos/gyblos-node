import type {
  BuyerCount,
  CollectorSnapshot,
  NetworkBuyers,
  NetworkDay,
  Totals,
} from './collector-shape';
import { COVERAGE_NOTES, DISPLAY, type CoverageState } from './constants';
import { count, latencyMs, percent, utc } from './format';
import { mergedLatency } from './latency';

type Section = Totals | null | undefined;
// Requests that ended in success or failure; cancellations are not failures and stay out.
const decided = (totals: Totals) =>
  totals.outcomes.completed + totals.outcomes.failed;

// completed / (completed + failed) over the given sections of one side, as in the Models table.
export function successRate(sections: Section[]): number | null {
  const done = sections.reduce(
    (sum, totals) => sum + (totals?.outcomes.completed ?? 0),
    0,
  );
  const all = sections.reduce(
    (sum, totals) => sum + (totals ? decided(totals) : 0),
    0,
  );
  return all ? done / all : null;
}

// One side's figures over any number of daily or model sections.
export function sideFigures(sections: Section[]) {
  return {
    requests: sections.reduce(
      (sum, totals) => sum + (totals?.requests.headline ?? 0),
      0,
    ),
    successRate: successRate(sections),
    tokens: sections.reduce(
      (sum, totals) =>
        sum + (totals ? totals.tokens.input + totals.tokens.output : 0),
      0,
    ),
    outputTokens: sections.reduce(
      (sum, totals) => sum + (totals?.tokens.output ?? 0),
      0,
    ),
    firstToken: mergedLatency(
      sections.map((totals) => totals?.sellerLatency.firstToken),
      DISPLAY.median,
    ),
    total: mergedLatency(
      sections.map((totals) => totals?.sellerLatency.total),
      DISPLAY.median,
    ),
  };
}
export type SideFigures = ReturnType<typeof sideFigures>;

export const rateText = (rate: number | null) =>
  rate === null ? '—' : percent(rate);
export const countText = count;
export const latencyText = latencyMs;

export function summarizeUsage(snapshot: CollectorSnapshot) {
  const active = snapshot.days.filter(
    (day) => day.free || day.paid || day.observed || day.demand.length,
  );
  const demand = new Map<string, number>();
  for (const day of active)
    for (const model of day.demand)
      demand.set(
        model.modelId,
        (demand.get(model.modelId) ?? 0) + model.requests,
      );
  return {
    active,
    free: sideFigures(active.map((day) => day.free)),
    paid: sideFigures(active.map((day) => day.paid)),
    authorized: active.reduce(
      (sum, day) => sum + BigInt(day.paid?.authorizedAtomic ?? '0'),
      0n,
    ),
    unserved: [...demand.values()].reduce((sum, value) => sum + value, 0),
    demand: [...demand].sort((left, right) => right[1] - left[1]),
  };
}

// The share of the day's routed executions that went through a relay.
export function relayText(day: NetworkDay): string {
  const routes = day.observed?.routes;
  const routed = routes ? routes.direct + routes.relay + routes.unknown : 0;
  return routes && routed ? percent(routes.relay / routed) : '—';
}

// One point per day of the range, oldest first: each side's headline requests (0 without receipts).
export function dailyRequests(
  days: readonly {
    day: string;
    free: Section;
    paid: Section;
    coverage?: CoverageState | null;
  }[],
) {
  return days.map((day) => {
    const note = day.coverage ? COVERAGE_NOTES[day.coverage] : undefined;
    return {
      day: day.day,
      free: day.free?.requests.headline ?? 0,
      paid: day.paid?.requests.headline ?? 0,
      ...(note ? { note } : {}),
    };
  });
}

// The Usage title's note: the comparison is named only when the span before the range could be read.
export function usageMeta(
  days: number,
  aggregatedAt: number | null,
  compared: boolean,
): string {
  if (!aggregatedAt) return 'no data yet';
  const updated = `updated ${utc(aggregatedAt)}`;
  return compared ? `vs previous ${days} days, ${updated}` : updated;
}

export const buyersText = (side: BuyerCount | null) =>
  !side
    ? '—'
    : side.withheld
      ? `< ${DISPLAY.minPublicBuyers}`
      : count(side.buyers ?? 0);

export const newBuyersText = (buyers: NetworkBuyers | null, days: number) =>
  buyers
    ? `New in the last ${days} days: ${buyersText(buyers.free.newInRange)} free · ${buyersText(buyers.paid.newInRange)} paid`
    : undefined;
