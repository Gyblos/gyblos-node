import { cache } from 'react';

import { dailyPayouts } from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { getOverviewNetwork } from '../lib/collector';
import { ALL_TIME, PAGES, PAGING } from '../lib/constants';
import { usdcDecimal } from '../lib/format';
import {
  firstOverviewDay,
  observedBaseline,
  overviewActivity,
} from '../lib/overview-activity';
import {
  queryHref,
  rangeOf,
  readQuery,
  type ExplorerQuery,
} from '../lib/paging';
import { overviewWindow, type RangeDays } from '../lib/range';
import { inclusiveDates } from '../lib/stats-window';
import { delta } from './board/delta';
import { OverviewChart } from './overview-chart';
import { SectionTitle } from './ui';

const readPeriod = cache(
  async (days: RangeDays, now: number, periodsBack: number) => {
    const [source, chain] = await Promise.all([
      getOverviewNetwork(days, now, periodsBack),
      getChainStats(days, periodsBack, true, now),
    ]);
    const first =
      days === ALL_TIME
        ? firstOverviewDay(source?.days ?? [], chain.days)
        : null;
    const last = source?.to ?? chain.days.at(-1)?.day;
    const dates =
      days === ALL_TIME
        ? first && last
          ? inclusiveDates(first, last)
          : []
        : overviewWindow(days, now, periodsBack);
    return {
      dates,
      source,
      chain,
      activity: overviewActivity(dates, source),
      paid: dailyPayouts(dates, chain),
    };
  },
);

type Period = Awaited<ReturnType<typeof readPeriod>>;

const WEEK = 7;
const interval = (dates: string[]) =>
  dates.length ? `${dates[0]} – ${dates.at(-1)} UTC` : 'Dates unavailable';

function metrics(period: Period, compared: Period, previous: Period) {
  const days = compared.dates.length;
  const comparison =
    days === 1 ? 'Last UTC day vs previous' : `Last ${days}d vs prior ${days}d`;
  const intervalNote = `${interval(compared.dates)} compared with ${interval(previous.dates)}`;
  const receipt = (key: 'tokens' | 'requests') => {
    const { activity: current } = compared;
    const baseline = observedBaseline(
      previous.activity[key],
      previous.activity.daysObserved,
      compared.source?.version ?? null,
      previous.source?.version ?? null,
    );
    const value = current[key];
    const change =
      value !== null && baseline !== null && current.daysObserved > 0
        ? delta(value, baseline)
        : null;
    return {
      total: period.activity[key],
      change,
      comparison,
      sample: `${current.daysObserved}/${days} vs ${previous.activity.daysObserved}/${days} days observed`,
      detail: `Published receipt totals · ${intervalNote}`,
    };
  };
  const recent = compared.paid;
  const earlier = previous.paid;
  return {
    tokens: receipt('tokens'),
    requests: receipt('requests'),
    paidOut: {
      total: period.paid.total === null ? null : usdcDecimal(period.paid.total),
      change:
        recent.complete &&
        earlier.complete &&
        recent.total !== null &&
        earlier.total !== null &&
        earlier.total > 0n
          ? delta(recent.total, earlier.total)
          : null,
      comparison,
      sample:
        recent.complete && earlier.complete
          ? 'Indexed payouts'
          : 'Partial chain history',
      detail: intervalNote,
    },
  };
}

async function readComparison(days: RangeDays, now: number) {
  const comparisonDays = days === ALL_TIME ? WEEK : days;
  const [period, compared, previous] = await Promise.all([
    readPeriod(days, now, 0),
    readPeriod(comparisonDays, now, 0),
    readPeriod(comparisonDays, now, 1),
  ]);
  return { period, metrics: metrics(period, compared, previous) };
}

export async function Overview({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'overview');
  const chartRange = query.ranges.chart ?? days;
  const now = Date.now();
  const [cards, chart] = await Promise.all([
    readComparison(days, now),
    readComparison(chartRange, now),
  ]);
  const { dates, source, activity, paid, chain } = chart.period;
  const stats = queryHref(
    { ...readQuery({}, PAGES.stats), closed: true },
    { days: chartRange },
  );
  return (
    <section aria-label="Period activity">
      <SectionTitle
        title="Period activity"
        meta={
          cards.period.dates.length ? interval(cards.period.dates) : 'All time'
        }
        range={{ section: 'overview', days }}
      />
      <OverviewChart
        points={activity.points.map((point, index) => {
          const amount = paid.points[index];
          return {
            ...point,
            paidOut: amount == null ? null : usdcDecimal(amount),
          };
        })}
        metrics={cards.metrics}
        chartMetrics={chart.metrics}
        globalDays={days}
        chartOverride={query.ranges.chart}
        chartDates={interval(dates)}
        receiptHref={`${stats}#${PAGING.anchors.daily}`}
        paymentHref={`${stats}#${PAGING.anchors.chainDaily}`}
        receiptNote={
          source
            ? `Published receipts · ${activity.daysObserved} of ${dates.length} days with observations`
            : 'Receipt data unavailable'
        }
        paymentNote={
          chain.error
            ? 'Chain data unavailable'
            : paid.complete && dates.length
              ? 'Indexed on-chain payouts'
              : 'Partial chain history'
        }
      />
    </section>
  );
}
