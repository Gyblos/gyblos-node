'use client';

import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Coins,
  Hash,
  MessagesSquare,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { DISPLAY, STATS } from '../lib/constants';
import { compact } from '../lib/overview-activity';
import { readQuery } from '../lib/paging';
import type { PeriodBar } from '../lib/period-bars';
import type { RangeDays } from '../lib/range';
import { Flow, type FlowValue } from './board/animated-number';
import { ChartReadout } from './board/chart-readout';
import { Chip } from './board/chip';
import { cx } from './board/cx';
import { DayBars, dayLabel } from './board/day-bars';
import type { Delta } from './board/delta';
import { DeltaChip } from './board/delta-chip';
import { StatCard } from './board/stat-card';
import { SURFACE } from './board/styles';
import { ChartRange } from './chart-range';
import { QueryRegion } from './query-region';

const METRICS = {
  tokens: { label: 'Tokens processed', kind: 'count', icon: Hash },
  requests: { label: 'Recorded requests', kind: 'count', icon: MessagesSquare },
  paidOut: { label: 'Paid to sellers', kind: 'usdc', icon: Coins },
} as const;
type Metric = keyof typeof METRICS;
const keys = Object.keys(METRICS) as Metric[];
type MetricData = {
  total: FlowValue;
  change: Delta | null;
};
type Metrics = Record<Metric, MetricData>;
type Point = PeriodBar;

interface OverviewChartProps {
  points: Point[];
  metrics: Metrics;
  chartMetrics: Metrics;
  globalDays: RangeDays;
  chartOverride?: RangeDays;
  chartDates: string;
  links: Record<Metric, string>;
  receiptNote: string;
  paymentNote: string;
}

function useMetric() {
  const search = useSearchParams();
  const selected =
    readQuery(new URLSearchParams(search.toString())).metric ?? 'tokens';
  const select = (metric: Metric) => {
    const url = new URL(window.location.href);
    if (metric === 'tokens') url.searchParams.delete(STATS.metricParam);
    else url.searchParams.set(STATS.metricParam, metric);
    window.history.replaceState(null, '', url);
  };
  return { selected, select };
}

function MonthControl({
  months,
  current,
  select,
}: {
  months: string[];
  current: string;
  select: (value: string) => void;
}) {
  const index = months.indexOf(current);
  return (
    <div className="sticky left-0 flex h-11 items-center gap-2 text-body-regular text-muted">
      <span className="text-body-medium">{current}</span>
      {months.length > 1 && (
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Previous month"
            disabled={index <= 0}
            className="grid size-11 place-items-center rounded-md outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:text-text-tertiary disabled:opacity-40"
            onClick={() => select(months[index - 1]!)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            aria-label="Next month"
            disabled={index >= months.length - 1}
            className="grid size-11 place-items-center rounded-md outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:text-text-tertiary disabled:opacity-40"
            onClick={() => select(months[index + 1]!)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function useChartMonth(series: Point[], duration: RangeDays) {
  const monthly = duration !== 1 && duration !== DISPLAY.weekWindow;
  const months = monthly ? [...new Set(series.map((row) => row.band))] : [];
  const [month, setMonth] = useState('');
  const currentMonth = months.includes(month) ? month : months.at(-1);
  const points = currentMonth
    ? series.filter((row) => row.band === currentMonth)
    : series;
  return { currentMonth, months, points, setMonth };
}

function peakValue(points: PeriodBar[], selected: Metric) {
  return points.reduce((max, row) => Math.max(max, Number(row[selected])), 0);
}

function pointDetail(
  point: Point | null | undefined,
  metric: Metric,
  props: OverviewChartProps,
) {
  if (!point)
    return metric === 'paidOut' ? props.paymentNote : props.receiptNote;
  const status = point.outside
    ? 'Outside period'
    : point[metric] === null
      ? 'No observation'
      : '';
  return [point.day + ' UTC', status].filter(Boolean).join(' · ');
}

function chartFrequency(duration: RangeDays) {
  if (duration === 1) return '30 min';
  return duration === DISPLAY.weekWindow ? '3h' : 'day';
}

export function OverviewChart(props: OverviewChartProps) {
  const { globalDays, chartOverride } = props;
  const { selected, select } = useMetric();
  const [active, setActive] = useState<number | null>(null);
  const duration = chartOverride ?? globalDays;
  const { currentMonth, months, points, setMonth } = useChartMonth(
    props.points,
    duration,
  );
  const point = active === null ? null : points[active];
  const { label, kind } = METRICS[selected];
  const maximum = peakValue(points, selected);
  const metric = props.chartMetrics[selected];
  const value = point ? point[selected] : metric.total;
  function selectMonth(next: string) {
    setActive(null);
    setMonth(next);
  }
  return (
    <>
      <MetricSelector
        metrics={props.metrics}
        selected={selected}
        onSelect={(metric) => {
          select(metric);
          setActive(null);
        }}
      />
      <QueryRegion>
        <section
          id="period-chart"
          className={cx(SURFACE.card, 'mt-3 min-w-0 p-4 sm:p-5')}
          aria-label={label + ' by ' + chartFrequency(duration)}
        >
          <ChartHeading
            label={label}
            frequency={chartFrequency(duration)}
            globalDays={globalDays}
            chartOverride={chartOverride}
            reset={() => selectMonth('')}
          />
          <ChartReadout
            kind={kind}
            value={value}
            badge={!point && <ComparisonChip metric={metric} />}
            detail={pointDetail(point, selected, props)}
          />
          <DayBars
            calendar={
              currentMonth && (
                <MonthControl
                  current={currentMonth}
                  months={months}
                  select={selectMonth}
                />
              )
            }
            points={points.map((row) => ({
              ...row,
              band: currentMonth ? undefined : row.band,
              value: row[selected] === null ? null : Number(row[selected]),
              amount: row[selected],
            }))}
            label={label}
            kind={kind}
            maximum={maximum}
            active={active}
            setActive={setActive}
          />
          <ChartScale points={points} selected={selected} maximum={maximum} />
          <ChartFooter
            chartDates={props.chartDates}
            href={props.links[selected]}
          />
        </section>
      </QueryRegion>
    </>
  );
}

function ChartHeading({
  label,
  frequency,
  globalDays,
  chartOverride,
  reset,
}: Pick<OverviewChartProps, 'globalDays' | 'chartOverride'> & {
  label: string;
  frequency: string;
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 min-[400px]:flex-row min-[400px]:items-baseline min-[400px]:justify-between">
      <h3 className="text-headline-medium">
        {label} by {frequency}
      </h3>
      <ChartRange
        globalDays={globalDays}
        override={chartOverride}
        onSelect={reset}
      />
    </div>
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
      className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3"
      role="group"
      aria-label="Activity metric"
    >
      {keys.map((key) => {
        const { label: name, kind: format, icon: Icon } = METRICS[key];
        const metric = metrics[key];
        return (
          <StatCard
            key={key}
            icon={Icon}
            label={name}
            selection={{
              pressed: key === selected,
              controls: 'period-chart',
              onPress: () => onSelect(key),
            }}
            value={<Flow kind={format} value={metric.total} />}
            comparison={<ComparisonChip metric={metric} />}
          />
        );
      })}
    </div>
  );
}

function ChartFooter({
  chartDates,
  href,
}: {
  chartDates: string;
  href: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
      <span>{chartDates}</span>
      <Link
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink hover:underline"
        href={href}
      >
        Daily breakdown <ArrowUpRight size={14} aria-hidden />
      </Link>
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
        {points.some((row) => !row.outside && row[selected] === null)
          ? 'Dashed mark · No observation'
          : 'UTC'}
      </span>
      {maximum > 0 && (
        <span>
          Peak ·{' '}
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

function ComparisonChip({ metric }: { metric: MetricData }) {
  return metric.change ? (
    <DeltaChip delta={metric.change} />
  ) : (
    <Chip>No baseline</Chip>
  );
}
