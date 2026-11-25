import { DISPLAY } from '../lib/constants';
import { usdcDecimal } from '../lib/format';
import { readHalfHours } from '../lib/intraday';
import { rangeOf, statsBreakdownHref, type ExplorerQuery } from '../lib/paging';
import { periodBars } from '../lib/period-bars';
import { interval, readComparison } from './activity-report';
import { OverviewChart } from './overview-chart';
import { SectionTitle } from './ui';

export async function Overview({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'overview');
  const chartRange = query.ranges.chart ?? days;
  const now = Date.now();
  const [cards, chart] = await Promise.all([
    readComparison(days, now),
    readComparison(chartRange, now),
  ]);
  const { dates, source, activity, paid, chain } = chart.period;
  const samples =
    chartRange === 1 || chartRange === DISPLAY.weekWindow
      ? await readHalfHours(dates)
      : [];
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
        points={periodBars(
          activity.points.map((point, index) => {
            const amount = paid.points[index];
            return {
              ...point,
              paidOut: amount == null ? null : usdcDecimal(amount),
            };
          }),
          chartRange,
          samples,
        )}
        metrics={cards.metrics}
        chartMetrics={chart.metrics}
        globalDays={days}
        chartOverride={query.ranges.chart}
        chartDates={interval(dates)}
        links={{
          tokens: statsBreakdownHref('tokens', chartRange),
          requests: statsBreakdownHref('requests', chartRange),
          paidOut: statsBreakdownHref('paidOut', chartRange),
        }}

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
