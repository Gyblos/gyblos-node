'use client';

import type { KeyboardEvent, ReactNode } from 'react';

import type { FlowKind, FlowValue } from './animated-number';
import { CHART, DELTA } from './constants';
import { cx } from './cx';

export interface BarPoint {
  day: string;
  value: number | null;
  amount: FlowValue;
  detail?: string;
  band?: string;
  tick?: string;
  outside?: boolean;
}
const DAY_WIDTH = 24;
const COMPACT_WIDTH = 14;
function moveDay(event: KeyboardEvent<HTMLButtonElement>) {
  const next =
    event.key === 'ArrowRight'
      ? event.currentTarget.nextElementSibling
      : event.key === 'ArrowLeft'
        ? event.currentTarget.previousElementSibling
        : null;
  if (next instanceof HTMLButtonElement) {
    event.preventDefault();
    next.focus();
  }
}

export function dayLabel(value: FlowValue, kind: FlowKind) {
  if (value === null) return 'No observation';
  return kind === 'usdc'
    ? `${value} USDC`
    : Number(value).toLocaleString('en-US');
}

function axisBands(points: BarPoint[]) {
  const bands: { label: string; size: number }[] = [];
  for (const row of points) {
    if (!row.band) continue;
    const previous = bands.at(-1);
    if (previous?.label === row.band) previous.size++;
    else bands.push({ label: row.band, size: 1 });
  }
  return bands;
}

function AxisLabels({
  points,
  minWidth,
}: {
  points: BarPoint[];
  minWidth: number;
}) {
  const bands = axisBands(points);
  return (
    bands.length > 0 && (
      <div
        className="flex h-11 items-center text-xs text-muted"
        style={{ minWidth }}
      >
        {bands.map((band) => (
          <span
            key={band.label}
            className="truncate"
            style={{ flex: band.size + ' 0 0%', minWidth: 0 }}
          >
            {band.label}
          </span>
        ))}
      </div>
    )
  );
}

export function DayBars({
  points,
  kind,
  label,
  maximum,
  active,
  setActive,
  calendar,
}: {
  calendar?: ReactNode;
  points: BarPoint[];
  label: string;
  kind: FlowKind;
  maximum: number;
  active: number | null;
  setActive: (index: number | null) => void;
}) {
  const minWidth =
    points.length * (points[0]?.tick ? COMPACT_WIDTH : DAY_WIDTH);
  return (
    <div className="mt-4 overflow-x-auto" onMouseLeave={() => setActive(null)}>
      {calendar || <AxisLabels points={points} minWidth={minWidth} />}
      <div
        data-loading-field="plot"
        style={{ minWidth }}
        className="flex gap-px"
      >
        {points.map((row, index) => {
          const amount = row.amount;
          const percentage =
            maximum > 0 ? ((row.value ?? 0) / maximum) * DELTA.percent : 0;
          return (
            <button
              type="button"
              key={row.day}
              className={cx(
                'flex min-w-0 flex-1 cursor-crosshair flex-col items-center rounded-sm focus-visible:outline-signal',
                index === active && 'bg-raised',
                row.outside && 'opacity-40',
              )}
              aria-label={`${row.day} UTC, ${label}, ${row.outside ? 'Outside selected period' : dayLabel(amount, kind)}`}
              tabIndex={index === (active ?? 0) ? 0 : -1}
              onKeyDown={moveDay}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(index)}
            >
              <span className="flex h-32 w-full items-end justify-center">
                {row.outside ? null : amount === null ? (
                  <span className="mb-px h-0 w-1/2 border-t border-dashed border-dim" />
                ) : (
                  <span
                    className="w-3/4 rounded-t-sm bg-chart"
                    style={{ height: `${percentage}%`, minHeight: 2 }}
                  />
                )}
              </span>
              <span className="mt-2 h-9 font-mono text-[10px] whitespace-nowrap text-dim [writing-mode:vertical-rl]">
                {row.tick ?? row.day.slice(CHART.monthDayStart)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
