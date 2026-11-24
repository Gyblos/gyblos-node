import { Hash, MessagesSquare, type LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { chainHistoryNote, summarizeChain } from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { getCollector } from '../lib/collector';
import { HELP_TEXT } from '../lib/config';
import { getDiscovery } from '../lib/discovery-render';
import { usdcDecimal } from '../lib/format';
import { overviewLayout } from '../lib/layout';
import { rangeOf, type ExplorerQuery } from '../lib/paging';
import { summarizeUsage } from '../lib/usage';
import { Flow } from './board/animated-number';
import { delta } from './board/delta';
import { StatCard } from './board/stat-card';
import { BuyersCard } from './buyers-card';
import { SellersOnline } from './network-section';
import { UsdcIcon } from './token-logo';
import { SectionTitle } from './ui';

function OverviewGrid({ cards }: { cards: ReactElement[] }) {
  const layout = overviewLayout(cards.length);
  return (
    <div className={layout.grid}>
      {cards.map((card, index) => (
        <div
          key={card.key ?? index}
          className={`grid min-w-0 ${layout.spans[index]}`}
        >
          {card}
        </div>
      ))}
    </div>
  );
}

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
  const cards = [
    snapshot.error ? null : (
      <SellersOnline key="sellers" snapshot={snapshot} variant="footer" />
    ),
    <SideCard
      key="requests"
      figure="requests"
      icon={MessagesSquare}
      label="Requests"
      usage={requests}
      before={requestsBefore}
    />,
    <BuyersCard
      key="buyers"
      variant="footer"
      buyers={usage.buyerTotals}
      days={days}
    />,
    <StatCard
      key="paid"
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
    />,
    <SideCard
      key="tokens"
      figure="tokens"
      icon={Hash}
      label="Tokens processed"
      hint={HELP_TEXT.tokens}
      usage={requests}
      before={requestsBefore}
    />,
  ].filter((card) => card !== null);
  return (
    <>
      <SectionTitle
        title={`Overview, last ${days} days`}
        range={{ section: 'overview', days }}
      />
      <OverviewGrid cards={cards} />
    </>
  );
}

type Usage = ReturnType<typeof summarizeUsage>;

function SideCard({
  usage,
  before,
  figure,
  ...card
}: {
  usage: Usage | null;
  before: Usage | null;
  figure: 'requests' | 'tokens';
  icon: LucideIcon;
  label: string;
  hint?: string;
}) {
  const kind = figure === 'tokens' ? 'compact' : 'count';
  const side = (paid: 'free' | 'paid') =>
    usage ? <Flow value={usage[paid][figure]} kind={kind} /> : '—';
  return (
    <StatCard
      {...card}
      variant="footer"
      sides={{ free: side('free'), paid: side('paid') }}
      deltas={
        usage && before
          ? [
              delta(usage.free[figure], before.free[figure]),
              delta(usage.paid[figure], before.paid[figure]),
            ]
          : undefined
      }
    />
  );
}
