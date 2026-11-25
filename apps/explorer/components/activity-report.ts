import { cache } from 'react';

import { dailyPayouts } from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { getOverviewNetwork } from '../lib/collector';
import { ALL_TIME } from '../lib/constants';
import { usdcDecimal } from '../lib/format';
import {
  firstOverviewDay,
  observedBaseline,
  overviewActivity,
} from '../lib/overview-activity';
import { overviewWindow, type RangeDays } from '../lib/range';
import { inclusiveDates } from '../lib/stats-window';
import { delta } from './board/delta';

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
export const interval = (dates: string[]) =>
  dates.length ? `${dates[0]} – ${dates.at(-1)} UTC` : 'Dates unavailable';

function metrics(period: Period, compared: Period, previous: Period) {
  const days = compared.dates.length;
  const comparison = days === 1 ? 'Daily change' : `${days}d change`;
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
      value !== null &&
      baseline !== null &&
      current.finalDays === days &&
      previous.activity.finalDays === days
        ? delta(value, baseline)
        : null;
    return {
      total: period.activity[key],
      change,
      comparison,
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
    },
  };
}

export async function readComparison(days: RangeDays, now: number) {
  const comparisonDays = days === ALL_TIME ? WEEK : days;
  const [period, compared, previous] = await Promise.all([
    readPeriod(days, now, 0),
    readPeriod(comparisonDays, now, 0),
    readPeriod(comparisonDays, now, 1),
  ]);
  return {
    period,
    compared,
    previous,
    metrics: metrics(period, compared, previous),
  };
}
