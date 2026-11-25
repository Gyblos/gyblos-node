'use client';

import { ArrowUpRight, Coins, Hash, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { STATS } from '../lib/constants';
import { compact, type TokenPoint } from '../lib/overview-activity';
import { readQuery } from '../lib/paging';
import type { RangeDays } from '../lib/range';
import { Flow, type FlowValue } from './board/animated-number';
import { Chip } from './board/chip';
import { cx } from './board/cx';
import { DayBars, dayLabel } from './board/day-bars';
import type { Delta } from './board/delta';
import { DeltaChip } from './board/delta-chip';
import { StatCard } from './board/stat-card';
import { SURFACE } from './board/styles';
import { ChartRange } from './chart-range';

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
  comparison: string;
  sample: string;
  detail: string;
};
type Metrics = Record<Metric, MetricData>;
type Point = TokenPoint & { paidOut: FlowValue };

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

export function OverviewChart({
  points,
  metrics,
  chartMetrics,
  globalDays,
  chartOverride,
  chartDates,
  links,
  receiptNote,
  paymentNote,
}: OverviewChartProps) {
  const { selected, select } = useMetric();
  const [active, setActive] = useState<number | null>(null);
  const point = active === null ? null : points[active];
  const { label, kind } = METRICS[selected];
  const maximum = Math.max(0, ...points.map((row) => Number(row[selected])));
  const money = selected === 'paidOut';
  const metric = chartMetrics[selected];
  const value = point ? point[selected] : metric.total;
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
          <ChartRange
            globalDays={globalDays}
            override={chartOverride}
            onSelect={() => setActive(null)}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <span className="font-mono text-2xl tabular-nums">
            <Flow kind={kind} value={value} />
          </span>
          {!point && <ComparisonChip metric={metric} />}
          <span className="text-xs text-muted">
            {point
              ? `${point.day} UTC${value === null ? ' · No observation' : ''}`
              : money
                ? paymentNote
                : receiptNote}
          </span>
        </div>
        <DayBars
          points={points.map((row) => ({
            day: row.day,
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
          chartDates={chartDates}
          comparison={metric.comparison}
          href={links[selected]}
        />
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
            caption={
              <span title={metric.detail}>
                {metric.comparison} · {metric.sample}
              </span>
            }
          />
        );
      })}
    </div>
  );
}

function ChartFooter({
  chartDates,
  comparison,
  href,
}: {
  chartDates: string;
  comparison: string;
  href: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
      <span>
        {chartDates} · {comparison}
      </span>
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

function ComparisonChip({ metric }: { metric: MetricData }) {
  return (
    <span
      title={`${metric.detail} · ${metric.sample}`}
      aria-label={`${metric.change?.label ?? 'No comparison'} · ${metric.comparison} · ${metric.sample}`}
    >
      {metric.change ? (
        <DeltaChip delta={metric.change} />
      ) : (
        <Chip>No baseline</Chip>
      )}
    </span>
  );
}
