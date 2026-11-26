import type { ChainDay } from './chain-shape';
import type { NetworkDay } from './collector-shape';
import { COVERAGE_STATES, DISPLAY } from './constants';

type Source = {
  days: NetworkDay[];
  version: number | null;
  updated: number | null;
} | null;

export function firstOverviewDay(receipts: NetworkDay[], chain: ChainDay[]) {
  const observed = [
    ...receipts.filter(
      (row) => row.free || row.paid || row.observed || row.demand.length,
    ),
    ...chain.filter((row) => row.gyblos),
  ];
  return observed.reduce<string | null>(
    (first, { day }) => (first === null || day < first ? day : first),
    null,
  );
}
export interface TokenPoint {
  day: string;
  tokens: number | null;
  requests: number | null;
}

export const compact = (value: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);

export function overviewActivity(
  dates: string[],
  source: Source,
  completeThrough: string | null = null,
) {
  const rows = new Map(source?.days.map((row) => [row.day, row]));
  const ordered = dates.map((day) => rows.get(day));
  const side = (mode: 'free' | 'paid') => {
    const published = ordered.flatMap((row) => row?.[mode] ?? []);
    if (
      !published.length &&
      !ordered.some((row) => row?.coverage === COVERAGE_STATES.FINAL)
    )
      return null;
    return {
      tokens: published.reduce(
        (sum, row) => sum + row.tokens.input + row.tokens.output,
        0,
      ),
      requests: published.reduce((sum, row) => sum + row.requests.headline, 0),
    };
  };
  const free = side('free');
  const paid = side('paid');
  const points = dates.map((day, index) => {
    const row = ordered[index];
    const sides = [row?.free, row?.paid].flatMap((value) => value ?? []);
    const measured =
      sides.length > 0 || row?.coverage === COVERAGE_STATES.FINAL;
    const input = measured
      ? sides.reduce((sum, value) => sum + value.tokens.input, 0)
      : null;
    const output = measured
      ? sides.reduce((sum, value) => sum + value.tokens.output, 0)
      : null;
    return {
      day,
      input,
      output,
      requests: measured
        ? sides.reduce((sum, value) => sum + value.requests.headline, 0)
        : null,
      tokens: input === null || output === null ? null : input + output,
    };
  });
  const through = dates.at(-1);
  const fresh =
    !!through &&
    !!source?.version &&
    completeThrough !== null &&
    completeThrough >= through;
  const demand = ordered.flatMap((row) => row?.demand ?? []);
  return {
    free,
    paid,
    points,
    tokens: free || paid ? (free?.tokens ?? 0) + (paid?.tokens ?? 0) : null,
    requests:
      free || paid ? (free?.requests ?? 0) + (paid?.requests ?? 0) : null,
    demand: demand.length
      ? demand.reduce((sum, row) => sum + row.requests, 0)
      : null,
    finalDays: ordered.filter((row) => row?.coverage === COVERAGE_STATES.FINAL)
      .length,
    complete: fresh && ordered.every((row) => row?.free && row.paid),
    demandComplete:
      fresh &&
      ordered.every(
        (row) =>
          row &&
          row.demand.length > 0 &&
          row.demand.length < DISPLAY.demandModelsPerDay,
      ),
    daysObserved: points.filter((point) => point.tokens !== null).length,
  };
}

export function observedBaseline(
  baseline: number | null,
  observedDays: number,
  currentVersion: number | null,
  previousVersion: number | null,
) {
  return baseline !== null &&
    baseline > 0 &&
    observedDays > 0 &&
    currentVersion !== null &&
    currentVersion === previousVersion
    ? baseline
    : null;
}
