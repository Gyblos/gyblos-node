import { Activity, MessagesSquare } from 'lucide-react';

import { chainHistoryNote, summarizeChain } from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { getCollector } from '../lib/collector';
import { getDiscovery } from '../lib/discovery-render';
import { count, percent, usdcDecimal } from '../lib/format';
import { summarizeOffers } from '../lib/offers';
import { rangeOf, type ExplorerQuery } from '../lib/paging';
import { summarizeUsage } from '../lib/usage';
import { Flow } from './board/animated-number';
import { delta } from './board/delta';
import { StatCard } from './board/stat-card';
import { BuyersCard } from './buyers-card';
import { SellersOnline } from './network-section';
import { UsdcIcon } from './token-logo';
import { SectionTitle } from './ui';

export async function Overview({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'overview');
  const [snapshot, usage, usageBefore, chain, chainBefore] = await Promise.all([
    getDiscovery(),
    getCollector(days),
    getCollector(days, 1),
    getChainStats(days),
    getChainStats(days, 1),
  ]);
  const requests = usage.error ? null : summarizeUsage(usage);
  const requestsBefore =
    requests && !usageBefore.error ? summarizeUsage(usageBefore) : null;
  const paid = chain.error ? null : summarizeChain(chain).totals.paidOut;
  const paidBefore =
    paid !== null && !chainBefore.error && chainBefore.backfillDone
      ? summarizeChain(chainBefore).totals.paidOut
      : null;
  const offers = snapshot.error ? null : summarizeOffers(snapshot);
  return (
    <>
      <SectionTitle
        title={`Overview, last ${days} days`}
        range={{ section: 'overview', days }}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {snapshot.error ? null : (
          <SellersOnline snapshot={snapshot} variant="footer" />
        )}
        <RequestsCard requests={requests} before={requestsBefore} />
        <BuyersCard
          variant="footer"
          className="sm:col-span-2 xl:col-span-1"
          buyers={usage.buyerTotals}
          days={days}
        />
        <StatCard
          variant="footer"
          icon={UsdcIcon}
          label="Paid to sellers"
          value={
            paid === null ? '—' : <Flow value={usdcDecimal(paid)} kind="usdc" />
          }
          deltas={
            paid !== null && paidBefore !== null
              ? [delta(paid, paidBefore)]
              : undefined
          }
          money={!!paid}
          caption={
            paid !== null && chainHistoryNote(chain.backfillDone) ? (
              <span className="inline-block first-letter:uppercase">
                {chainHistoryNote(chain.backfillDone)}, partial total
              </span>
            ) : undefined
          }
        />
        <StatCard
          variant="footer"
          icon={Activity}
          label="Uptime 24 h"
          value={
            offers?.averageDayUptime == null
              ? '—'
              : percent(offers.averageDayUptime)
          }
          caption={
            offers?.averageDayUptime == null || snapshot.error
              ? undefined
              : `Average of ${count(offers.sellersWithDayUptime)} ${offers.sellersWithDayUptime === 1 ? 'seller' : 'sellers'}`
          }
        />
      </div>
    </>
  );
}

function RequestsCard({
  requests,
  before,
}: {
  requests: ReturnType<typeof summarizeUsage> | null;
  before: ReturnType<typeof summarizeUsage> | null;
}) {
  const side = (figure: 'free' | 'paid') =>
    requests ? <Flow value={requests[figure].requests} kind="count" /> : '—';
  return (
    <StatCard
      variant="footer"
      icon={MessagesSquare}
      label="Requests"
      sides={{ free: side('free'), paid: side('paid') }}
      deltas={
        requests && before
          ? [
              delta(requests.free.requests, before.free.requests),
              delta(requests.paid.requests, before.paid.requests),
            ]
          : undefined
      }
    />
  );
}
