'use client';

import { useState } from 'react';

import type { FlowKind, FlowValue } from './animated-number';
import { barAxis } from './bar-axis';
import { ChartReadout } from './chart-readout';
import { Chip } from './chip';
import { cx } from './cx';
import { DayBars, type BarPoint } from './day-bars';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';
import { SURFACE } from './styles';

export type { BarPoint } from './day-bars';

function activeDetail(active: BarPoint) {
  const detail =
    active.amount === null
      ? (active.detail ?? 'No observation')
      : active.detail;
  return [active.day, detail].filter(Boolean).join(', ');
}

export function BarChartCard({
  title,
  kind,
  total,
  points,
  change,
  countAxis = true,
  comparison,
  summary,
  startAtEnd,
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
  summary?: string;
  startAtEnd?: boolean;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const active = index === null ? null : points[index];
  const maximum = points.reduce(
    (peak, row) => Math.max(peak, row.value ?? 0),
    0,
  );
  return (
    <div className={cx('min-w-0 p-4 sm:p-5', SURFACE.card)}>
      <div className="text-body-medium text-muted">{title}</div>
      <ChartReadout
        kind={kind}
        value={active ? active.amount : total}
        badge={
          !active &&
          (change ? (
            <DeltaChip delta={change} />
          ) : comparison ? (
            <Chip>No baseline</Chip>
          ) : null)
        }
        detail={
          active ? activeDetail(active) : (summary ?? `${points.length} days`)
        }
      />
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
            startAtEnd={startAtEnd}
          />
        </div>
      </div>
      <p className="mt-2 min-h-4 text-xs text-dim">
        {points.some((row) => row.value === null) &&
          'Dashed mark · No observation'}
      </p>
    </div>
  );
}
