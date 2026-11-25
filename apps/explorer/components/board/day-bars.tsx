'use client';

import type { KeyboardEvent } from 'react';

import type { FlowKind, FlowValue } from './animated-number';
import { CHART, DELTA } from './constants';
import { cx } from './cx';

export interface BarPoint {
  day: string;
  value: number | null;
  amount: FlowValue;
  detail?: string;
}
const DAY_WIDTH = 24;
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

export function DayBars({
  points,
  kind,
  label,
  maximum,
  active,
  setActive,
}: {
  points: BarPoint[];
  label: string;
  kind: FlowKind;
  maximum: number;
  active: number | null;
  setActive: (index: number | null) => void;
}) {
  return (
    <div className="mt-4 overflow-x-auto" onMouseLeave={() => setActive(null)}>
      <div
        style={{ minWidth: points.length * DAY_WIDTH }}
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
              )}
              aria-label={`${row.day} UTC, ${label}, ${dayLabel(amount, kind)}`}
              tabIndex={index === (active ?? 0) ? 0 : -1}
              onKeyDown={moveDay}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(index)}
            >
              <span className="flex h-32 w-full items-end justify-center">
                {amount === null ? (
                  <span className="mb-px h-0 w-1/2 border-t border-dashed border-dim" />
                ) : (
                  <span
                    className="w-3/4 rounded-t-sm bg-chart"
                    style={{ height: `${percentage}%`, minHeight: 2 }}
                  />
                )}
              </span>
              <span className="mt-2 font-mono text-[10px] whitespace-nowrap text-dim [writing-mode:vertical-rl]">
                {row.day.slice(CHART.monthDayStart)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
