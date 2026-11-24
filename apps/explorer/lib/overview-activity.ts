import type { overviewNetwork } from './collector';
import { UNITS } from './constants';

type Source = Awaited<ReturnType<typeof overviewNetwork>>;
export interface TokenPoint {
  day: string;
  tokens: number | null;
}

export const compact = (value: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);

export function overviewActivity(dates: string[], source: Source) {
  const rows = new Map(source?.days.map((row) => [row.day, row]));
  const ordered = dates.map((day) => rows.get(day));
  const side = (mode: 'free' | 'paid') => {
    const published = ordered.flatMap((row) => row?.[mode] ?? []);
    if (!published.length) return null;
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
    return {
      day,
      tokens: sides.length
        ? sides.reduce(
            (sum, value) => sum + value.tokens.input + value.tokens.output,
            0,
          )
        : null,
    };
  });
  const through = dates.at(-1);
  const fresh =
    !!through &&
    !!source?.version &&
    source.updated >= Date.parse(through) + UNITS.msPerDay;
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
    complete: fresh && ordered.every((row) => row?.free && row.paid),
    demandComplete:
      fresh &&
      ordered.every(
        (row) => row && row.demand.length > 0 && row.demand.length < 20,
      ),
    daysObserved: points.filter((point) => point.tokens !== null).length,
  };
}

export function groupWeeks(points: TokenPoint[]) {
  const weeks: {
    day: string;
    end: string;
    tokens: number | null;
    missing: number;
  }[] = [];
  for (const point of points) {
    if (!weeks.length || new Date(point.day).getUTCDay() === 1)
      weeks.push({ day: point.day, end: point.day, tokens: null, missing: 0 });
    const week = weeks.at(-1);
    if (!week) continue;
    week.end = point.day;
    if (point.tokens === null) week.missing++;
    else week.tokens = (week.tokens ?? 0) + point.tokens;
  }
  return weeks;
}
