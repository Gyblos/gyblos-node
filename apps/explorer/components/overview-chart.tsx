'use client';

import { ArrowUpRight, Coins, Hash, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { useState, type KeyboardEvent } from 'react';

import { UNITS } from '../lib/constants';
import { compact, type TokenPoint } from '../lib/overview-activity';
import { Flow, type FlowKind, type FlowValue } from './board/animated-number';
import { CHART } from './board/constants';
import { cx } from './board/cx';
import type { Delta } from './board/delta';
import { DeltaChip } from './board/delta-chip';
import { SURFACE } from './board/styles';

const METRICS = {
  tokens: { label: 'Tokens processed', kind: 'count', icon: Hash },
  requests: { label: 'Recorded requests', kind: 'count', icon: MessagesSquare },
  paidOut: { label: 'Paid to sellers', kind: 'usdc', icon: Coins },
} as const;
const DAY_WIDTH = 19;
type Metric = keyof typeof METRICS;
const keys = Object.keys(METRICS) as Metric[];
type Metrics = Record<Metric, { total: FlowValue; change: Delta | null }>;
type Point = TokenPoint & { paidOut: FlowValue };

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

function dayLabel(value: FlowValue, kind: FlowKind) {
  if (value === null) return 'No observation';
  return kind === 'usdc'
    ? `${value} USDC`
    : Number(value).toLocaleString('en-US');
}

export function OverviewChart({
  points,
  metrics,
  receiptHref,
  paymentHref,
  receiptNote,
  paymentNote,
}: {
  points: Point[];
  metrics: Metrics;
  receiptHref: string;
  paymentHref: string;
  receiptNote: string;
  paymentNote: string;
}) {
  const [selected, select] = useState<Metric>('tokens');
  const [active, setActive] = useState<number | null>(null);
  const point = active === null ? null : points[active];
  const { label, kind } = METRICS[selected];
  const maximum = Math.max(0, ...points.map((row) => Number(row[selected])));
  const money = selected === 'paidOut';
  const value = point ? point[selected] : metrics[selected].total;
  return (
    <>
      <MetricSelector
        metrics={metrics}
        selected={selected}
        onSelect={(metric) => {
          select(metric);
          setActive(null);
        }}
      />
      <section
        id="period-chart"
        className={cx(SURFACE.card, 'mt-3 min-w-0 p-4 sm:p-5')}
        aria-label={`Daily ${label.toLowerCase()}`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-medium">{label} by day</h3>
          <Link
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink hover:underline"
            href={money ? paymentHref : receiptHref}
          >
            Daily breakdown <ArrowUpRight size={14} aria-hidden />
          </Link>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <span className="font-mono text-2xl tabular-nums">
            <Flow kind={kind} value={value} />
          </span>
          <span className="text-xs text-muted">
            {point
              ? `${point.day} UTC${value === null ? ' · No observation' : ''}`
              : money
                ? paymentNote
                : receiptNote}
          </span>
        </div>
        <DayBars
          points={points}
          selected={selected}
          maximum={maximum}
          active={active}
          setActive={setActive}
        />
        <ChartScale points={points} selected={selected} maximum={maximum} />
      </section>
    </>
  );
}

function MetricSelector({
  metrics,
  selected,
  onSelect,
}: {
  metrics: Metrics;
  selected: Metric;
  onSelect: (metric: Metric) => void;
}) {
  return (
    <div
      className="grid gap-2 sm:grid-cols-3"
      role="group"
      aria-label="Activity metric"
    >
      {keys.map((key) => {
        const { label: name, kind: format, icon: Icon } = METRICS[key];
        const { total, change } = metrics[key];
        return (
          <button
            key={key}
            type="button"
            aria-pressed={key === selected}
            aria-controls="period-chart"
            className={cx(
              SURFACE.card,
              SURFACE.focus,
              'min-w-0 cursor-pointer p-4 text-left transition-colors hover:bg-raised sm:p-5',
              key === selected && 'ring-1 ring-inset ring-signal',
            )}
            onClick={() => onSelect(key)}
          >
            <span className="flex items-center gap-2 text-sm text-muted">
              <Icon size={16} aria-hidden />
              {name}
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-2xl tabular-nums">
                <Flow kind={format} value={total} />
              </span>
              {change && <DeltaChip delta={change} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DayBars({
  points,
  selected,
  maximum,
  active,
  setActive,
}: {
  points: Point[];
  selected: Metric;
  maximum: number;
  active: number | null;
  setActive: (index: number | null) => void;
}) {
  const { label, kind } = METRICS[selected];
  return (
    <div className="mt-4 overflow-x-auto" onMouseLeave={() => setActive(null)}>
      <div
        style={{ minWidth: points.length * DAY_WIDTH }}
        className="flex gap-px"
      >
        {points.map((row, index) => {
          const amount = row[selected];
          const percentage =
            maximum > 0 ? (Number(amount) / maximum) * UNITS.percent : 0;
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

function ChartScale({
  points,
  selected,
  maximum,
}: {
  points: Point[];
  selected: Metric;
  maximum: number;
}) {
  const money = selected === 'paidOut';
  const { kind } = METRICS[selected];
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted">
      <span>
        {points.some((row) => row[selected] === null)
          ? 'Dashed mark · No observation'
          : 'UTC days'}
      </span>
      {maximum > 0 && (
        <span>
          Daily peak ·{' '}
          {money
            ? dayLabel(
                points.find((row) => Number(row[selected]) === maximum)?.[
                  selected
                ] ?? null,
                kind,
              )
            : compact(maximum)}
        </span>
      )}
    </div>
  );
}
