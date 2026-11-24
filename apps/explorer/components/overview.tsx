import { dailyPayouts } from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { overviewNetwork } from '../lib/collector';
import { PAGES, PAGING } from '../lib/constants';
import { usdcDecimal } from '../lib/format';
import { overviewActivity } from '../lib/overview-activity';
import {
  queryHref,
  rangeOf,
  readQuery,
  type ExplorerQuery,
} from '../lib/paging';
import { overviewWindow } from '../lib/range';
import { delta } from './board/delta';
import { OverviewChart } from './overview-chart';
import { SectionTitle } from './ui';

export async function Overview({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'overview');
  const now = Date.now();
  const dates = overviewWindow(days, now);
  const prior = overviewWindow(days, now, 1);
  const [source, before, chain, earlierChain] = await Promise.all([
    overviewNetwork(dates),
    overviewNetwork(prior),
    getChainStats(days, 0, true, now),
    getChainStats(days, 1, true, now),
  ]);
  const current = overviewActivity(dates, source);
  const previous = overviewActivity(prior, before);
  const paid = dailyPayouts(dates, chain);
  const earlier = dailyPayouts(prior, earlierChain);
  const stats = queryHref(
    { ...readQuery({}, PAGES.stats), closed: true },
    { days },
  );
  const receiptChange = (metric: 'tokens' | 'requests') => {
    const value = current[metric];
    const baseline = previous[metric];
    return current.complete &&
      previous.complete &&
      source?.version === before?.version &&
      value !== null &&
      baseline !== null
      ? delta(value, baseline)
      : null;
  };
  return (
    <section aria-label="Period activity">
      <SectionTitle
        title="Period activity"
        meta={`${dates[0]} – ${dates.at(-1)} UTC`}
        range={{ section: 'overview', days }}
      />
      <OverviewChart
        points={current.points.map((point, index) => {
          const amount = paid.points[index];
          return {
            ...point,
            paidOut: amount == null ? null : usdcDecimal(amount),
          };
        })}
        metrics={{
          tokens: { total: current.tokens, change: receiptChange('tokens') },
          requests: {
            total: current.requests,
            change: receiptChange('requests'),
          },
          paidOut: {
            total: paid.total === null ? null : usdcDecimal(paid.total),
            change:
              paid.complete &&
              earlier.complete &&
              paid.total !== null &&
              earlier.total !== null
                ? delta(paid.total, earlier.total)
                : null,
          },
        }}
        receiptHref={`${stats}#${PAGING.anchors.daily}`}
        paymentHref={`${stats}#${PAGING.anchors.chainDaily}`}
        receiptNote={
          source
            ? `Published receipts · ${current.daysObserved} of ${days} days with observations`
            : 'Receipt data unavailable'
        }
        paymentNote={
          chain.error
            ? 'Chain data unavailable'
            : paid.complete
              ? 'Indexed on-chain payouts'
              : 'Partial chain history'
        }
      />
    </section>
  );
}
