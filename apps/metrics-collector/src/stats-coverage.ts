import { dayBounds, dayOfTime, daysOf, type DayRange } from './days';

export const COVERAGE_STATES = {
  FINAL: 'final',
  PARTIAL: 'partial',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
} as const;
export type CoverageState =
  (typeof COVERAGE_STATES)[keyof typeof COVERAGE_STATES];

export interface DayCoverage {
  state: CoverageState;
  cutoff: number | null;
  revision: number | null;
}
export interface CoverageRows {
  days: { day: string; cutoff: number; revision: number }[];
  pending: { day: string }[];
  receiptStart: { day: string | null }[];
  eventStart: { at: number | null }[];
  demand: { day: string; models: number; total: number | null }[];
}

export function captureStartDay(
  receipts: readonly { day: string | null }[],
  events: readonly { at: number | null }[],
): string | null {
  const days = [
    receipts[0]?.day ?? null,
    events[0]?.at == null ? null : dayOfTime(events[0].at),
  ].filter((day): day is string => day !== null);
  return days.length
    ? days.reduce((low, day) => (day < low ? day : low))
    : null;
}

export function dayCoverage(
  rows: CoverageRows,
  range: DayRange,
  today: string,
) {
  const computed = new Map(rows.days.map((row) => [row.day, row]));
  const pending = new Set(rows.pending.map((row) => row.day));
  const start = captureStartDay(rows.receiptStart, rows.eventStart);
  const demand = new Map(rows.demand.map((row) => [row.day, row]));
  const days = daysOf(range).map((day) => {
    const row = computed.get(day);
    const state =
      start === null || day < start || day > today
        ? COVERAGE_STATES.UNKNOWN
        : pending.has(day)
          ? COVERAGE_STATES.PENDING
          : day === today
            ? COVERAGE_STATES.PARTIAL
            : row && row.cutoff >= dayBounds(day)!.end
              ? COVERAGE_STATES.FINAL
              : COVERAGE_STATES.PENDING;
    return {
      day,
      coverage: {
        state,
        cutoff: row?.cutoff ?? null,
        revision: row?.revision ?? null,
      } satisfies DayCoverage,
      demandModels: demand.get(day)?.models ?? 0,
      demandTotal: demand.get(day)?.total ?? 0,
    };
  });
  let completeThrough: string | null = null;
  for (const { day, coverage } of days) {
    if (coverage.state === COVERAGE_STATES.UNKNOWN && completeThrough === null)
      continue;
    if (coverage.state !== COVERAGE_STATES.FINAL) break;
    completeThrough = day;
  }
  return { days, completeThrough };
}
