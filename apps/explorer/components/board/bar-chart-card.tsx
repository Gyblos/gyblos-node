'use client';

import { useState } from 'react';

import { Flow, type FlowKind, type FlowValue } from './animated-number';
import { barAxis } from './bar-axis';
import { Chip } from './chip';
import { cx } from './cx';
import { DayBars, type BarPoint } from './day-bars';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';
import { SURFACE } from './styles';

export type { BarPoint } from './day-bars';

export function BarChartCard({
  title,
  kind,
  total,
  points,
  change,
  countAxis = true,
  comparison,
}: {
  title: string;
  kind: FlowKind;
  total: FlowValue;
  // The total's change against the previous period; hidden while a day is hovered.
  change?: Delta | null;
  points: BarPoint[];
  // A count axis (whole numbers); amounts hide it and read from the headline instead.
  countAxis?: boolean;
  comparison?: string;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const active = index === null ? null : points[index];
  const maximum = points.reduce(
    (peak, row) => Math.max(peak, row.value ?? 0),
    0,
  );
  return (
    <div className={cx('min-w-0 p-4 sm:p-5', SURFACE.card)}>
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-2xl">
          <Flow value={active ? active.amount : total} kind={kind} />
        </span>
        {change && !active ? <DeltaChip delta={change} /> : null}
        {!active && comparison && !change && <Chip>No baseline</Chip>}
        <span className="font-mono text-xs text-dim">
          {active
            ? [
                active.day,
                active.amount === null ? 'No observation' : active.detail,
              ]
                .filter(Boolean)
                .join(', ')
            : (comparison ?? `${points.length} days`)}
        </span>
      </div>
      <div className="flex min-w-0 gap-2">
        {!barAxis(countAxis).hide && maximum > 0 && (
          <div
            aria-hidden="true"
            className="mt-4 flex h-32 flex-col justify-between text-right font-mono text-xs text-dim"
          >
            <span>{maximum.toLocaleString('en-US')}</span>
            <span>0</span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <DayBars
            points={points}
            maximum={maximum}
            kind={kind}
            label={title}
            active={index}
            setActive={setIndex}
          />
        </div>
      </div>
      {points.some((row) => row.value === null) && (
        <p className="mt-2 text-xs text-dim">Dashed mark · No observation</p>
      )}
    </div>
  );
}
