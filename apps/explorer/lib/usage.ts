// Owns the sums the Usage section shows over the collector's daily answers. Free and paid are kept
// apart; percentiles come from summed histograms, never from averaged percentiles.
import {
  mergedLatency,
  type CollectorSnapshot,
  type NetworkDay,
  type Totals,
} from './collector';
import { DISPLAY } from './constants';
import { percent } from './format';

export const finished = (totals: Totals) =>
  totals.outcomes.completed +
  totals.outcomes.failed +
  totals.outcomes.cancelled;
export const headline = (totals: Totals | null | undefined) =>
  totals?.requests.headline ?? 0;
export const tokensOut = (totals: Totals | null | undefined) =>
  totals?.tokens.output ?? 0;
export const sidesOf = (day: NetworkDay) => [day.free, day.paid];

// completed / (completed + failed + cancelled) over every given section.
export function successText(parts: (Totals | null | undefined)[]): string {
  const done = parts.reduce(
    (sum, totals) => sum + (totals?.outcomes.completed ?? 0),
    0,
  );
  const all = parts.reduce(
    (sum, totals) => sum + (totals ? finished(totals) : 0),
    0,
  );
  return all ? percent(done / all) : '—';
}
export const medianFirstToken = (parts: (Totals | null | undefined)[]) =>
  mergedLatency(
    parts.map((totals) => totals?.sellerLatency.firstToken),
    DISPLAY.median,
  );
const demandOf = (day: NetworkDay) =>
  day.demand.map((model) => ({
    modelId: model.modelId,
    requests:
      model.unserved + model.refusedBeforeSelection + model.connectFailed,
  }));

export function summarizeUsage(snapshot: CollectorSnapshot) {
  const active = snapshot.days.filter(
    (day) => day.free || day.paid || day.observed || day.demand.length,
  );
  const sections = active.flatMap(sidesOf);
  const demand = new Map<string, number>();
  for (const day of active)
    for (const model of demandOf(day))
      demand.set(
        model.modelId,
        (demand.get(model.modelId) ?? 0) + model.requests,
      );
  return {
    active,
    sections,
    free: active.reduce((sum, day) => sum + headline(day.free), 0),
    paid: active.reduce((sum, day) => sum + headline(day.paid), 0),
    authorized: active.reduce(
      (sum, day) => sum + BigInt(day.paid?.authorizedAtomic ?? '0'),
      0n,
    ),
    outputTokens: sections.reduce((sum, totals) => sum + tokensOut(totals), 0),
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
