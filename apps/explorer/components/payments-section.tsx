// Owns the Payments section: what Gyblos channels moved on Solana devnet, from the collector's chain
// index (GET /v1/stats/chain): settled USDC, payouts to sellers, Gyblos fees, refunds, volume per day,
// and the whole program's traffic for scale. Gyblos traffic is a label the channel's open declares.
import {
  ArrowDownToLine,
  ArrowUpRight,
  Coins,
  Landmark,
  ListOrdered,
  Percent,
  Undo2,
  Unlock,
} from 'lucide-react';

import {
  dailySettled,
  summarizeChain,
  type ChainSnapshot,
  type ChainSummary,
} from '../lib/chain-shape';
import { PAGING, UNITS } from '../lib/constants';
import { count, settlementCount, usdc, usdcDecimal } from '../lib/format';
import { tablePager, type ExplorerQuery } from '../lib/paging';
import type { readComparison } from './activity-report';
import { Flow } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { delta, type Delta } from './board/delta';
import { StatCard } from './board/stat-card';
import { pagedRows, Pager } from './pager';
import { StatsBreakdown } from './stats-breakdown';
import { EmptyRow, numberCell, Table, timeCell, Unavailable } from './ui';

const money = (atomic: bigint) => (
  <Flow value={usdcDecimal(atomic)} kind="usdc" />
);

// Each figure's change against the span just before the range; none when it cannot be read or the
// chain history is still being read (an incomplete earlier span would overstate every change).
function changes(period: ChainSummary, before: ChainSnapshot) {
  if (before.error || !before.backfillDone) return null;
  const current = period.totals;
  const baseline = summarizeChain(before);
  const previous = baseline.totals;
  return {
    transactions: [
      previous.transactions > 0
        ? delta(current.transactions, previous.transactions)
        : null,
    ],
    feeShare: [
      period.feeShare !== null && baseline.feeShare && baseline.feeShare > 0
        ? delta(period.feeShare, baseline.feeShare, 'none')
        : null,
    ],
    settled: [
      previous.settled > 0 ? delta(current.settled, previous.settled) : null,
    ],
    paidOut: [
      previous.paidOut > 0 ? delta(current.paidOut, previous.paidOut) : null,
    ],
    gyblosFees: [
      previous.gyblosFees > 0
        ? delta(current.gyblosFees, previous.gyblosFees)
        : null,
    ],
    opens: [previous.opens > 0 ? delta(current.opens, previous.opens) : null],
    deposited: [
      previous.deposited > 0
        ? delta(current.deposited, previous.deposited)
        : null,
    ],
    refunded: [
      previous.refunded > 0
        ? delta(current.refunded, previous.refunded, 'none')
        : null,
    ],
  };
}

export async function PaymentsSection({
  query,
  reportPromise,
}: {
  query: ExplorerQuery;
  reportPromise: ReturnType<typeof readComparison>;
}) {
  const report = await reportPromise;
  const focus = query.metric === 'paidOut';
  const chain = report.period.chain;
  const before = report.previous.chain;
  if (chain.error)
    return (
      <Unavailable title="Payments" anchors={[PAGING.anchors.chainDaily]} />
    );
  const summary = summarizeChain(chain);
  const { totals } = summary;
  const change =
    report.compared.paid.complete && report.previous.paid.complete
      ? changes(summarizeChain(report.compared.chain), before)
      : null;
  return (
    <section aria-labelledby="payments">
      <h2 id="payments" className="mb-5 text-title-2-medium">
        Payments
      </h2>
      {focus && (
        <div className="mb-6">
          <StatsBreakdown query={query} report={report} metric="paidOut" />
        </div>
      )}
      <PaymentStats
        summary={summary}
        change={change}
        paidOut={report.period.paid.total}
      />
      <SettledChart
        dates={report.period.dates}
        chain={chain}
        total={totals.settled}
        change={change?.settled[0]}
      />
      {!focus && (
        <ChainHistory
          query={query}
          summary={summary}
          complete={chain.backfillDone === true}
        />
      )}
    </section>
  );
}

function PaymentStats({
  summary,
  change,
  paidOut,
}: {
  paidOut: bigint | null;
  summary: ChainSummary;
  change: ReturnType<typeof changes>;
}) {
  const { totals } = summary;
  return (
    <div className="grid grid-cols-1 gap-3 min-[390px]:grid-cols-2 lg:grid-cols-4">
      <StatCard
        icon={Coins}
        label="Settled"
        value={money(totals.settled)}
        deltas={change?.settled ?? [null]}
        money
      />
      <StatCard
        icon={ArrowUpRight}
        label="Paid to sellers"
        value={paidOut === null ? '—' : money(paidOut)}
        deltas={change?.paidOut ?? [null]}
        money
      />
      <StatCard
        icon={Landmark}
        label="Gyblos fees"
        value={money(totals.gyblosFees)}
        deltas={change?.gyblosFees ?? [null]}
        money
      />
      <StatCard
        icon={Percent}
        label="Effective fee"
        deltas={change?.feeShare ?? [null]}
        hint="Gyblos fees as a share of what buyers paid out: fees divided by fees plus what sellers received."
        value={<Flow value={summary.feeShare} kind="percent" />}
      />
      <StatCard
        icon={Unlock}
        label="Channels opened"
        value={<Flow value={totals.opens} kind="count" />}
        deltas={change?.opens ?? [null]}
      />
      <StatCard
        icon={ArrowDownToLine}
        label="Deposited"
        value={money(totals.deposited)}
        deltas={change?.deposited ?? [null]}
        money
      />
      <StatCard
        icon={Undo2}
        label="Refunded"
        value={money(totals.refunded)}
        deltas={change?.refunded ?? [null]}
      />
      <StatCard
        icon={ListOrdered}
        label="Gyblos transactions"
        deltas={change?.transactions ?? [null]}
        value={count(totals.transactions)}
        caption={`of ${count(summary.programTransactions)} in the payments program`}
      />
    </div>
  );
}

// Settled USDC per day; the bar height is approximate, the labels exact.
function SettledChart({
  dates,
  chain,
  total,
  change,
}: {
  chain: ChainSnapshot;
  dates: string[];
  total: bigint;
  change?: Delta | null;
}) {
  const points = dailySettled(chain, dates).map((day) => ({
    day: day.day,
    value:
      day.settled === null ? null : Number(day.settled) / UNITS.atomicPerUsdc,
    amount: day.settled === null ? null : usdcDecimal(day.settled),
    detail: day.settles === null ? undefined : settlementCount(day.settles),
  }));
  if (!points.length) return null;
  return (
    <div className="mt-6 sm:mt-8">
      <BarChartCard
        title="Settled per day"
        kind="usdc"
        total={
          points.some((row) => row.amount !== null) ? usdcDecimal(total) : null
        }
        points={points}
        change={change}
        countAxis={false}
      />
    </div>
  );
}

const CHAIN_HEAD = [
  { label: 'Day (UTC)', sort: 'day', ascendingFirst: true },
  { label: 'Settled', right: true, group: 'USDC', sort: 'settled' },
  { label: 'To sellers', right: true, group: 'USDC', sort: 'paidOut' },
  { label: 'Gyblos fees', right: true, group: 'USDC' },
  { label: 'Refunded', right: true, group: 'USDC' },
  { label: 'Channels opened', right: true, group: 'Activity' },
  { label: 'Settlements', right: true, group: 'Activity' },
  { label: 'All program txs', right: true, group: 'Activity' },
];

function ChainHistory({
  query,
  summary,
  complete,
}: {
  query: ExplorerQuery;
  summary: ChainSummary;
  complete: boolean;
}) {
  const page = pagedRows(
    query,
    'chainDaily',
    [...summary.days].reverse(),
    complete,
    {
      day: (row) => row.day,
      settled: (row) => row.gyblos.settled,
      paidOut: (row) => row.gyblos.paidOut,
    },
  );
  return (
    <section
      aria-labelledby="chain-history-title"
      id={PAGING.anchors.chainDaily}
      className="mt-8 scroll-mt-4"
    >
      <Table
        heading={
          <h3 id="chain-history-title" className="text-title-3-medium">
            Daily on chain
          </h3>
        }
        head={CHAIN_HEAD}
        sorting={{ query, table: 'chainDaily' }}
        compactLabel="Daily on-chain columns"
        footer={
          <Pager
            label="Daily on chain"
            view={tablePager(query, 'chainDaily', page)}
          />
        }
      >
        {page.rows.map(({ day, gyblos, program }) => (
          <tr key={day} className="border-t border-line">
            <td className={timeCell}>
              <time dateTime={day}>{day}</time>
            </td>
            <td className={numberCell}>{usdc(gyblos.settled)}</td>
            <td className={numberCell}>{usdc(gyblos.paidOut)}</td>
            <td className={numberCell}>{usdc(gyblos.gyblosFees)}</td>
            <td className={numberCell}>{usdc(gyblos.refunded)}</td>
            <td className={numberCell}>{count(gyblos.opens)}</td>
            <td className={numberCell}>{count(gyblos.settles)}</td>
            <td className={numberCell}>
              {program ? count(program.transactions) : '—'}
            </td>
          </tr>
        ))}
        {!page.total && (
          <EmptyRow columns={CHAIN_HEAD.length}>
            No indexed channel activity in this period.
          </EmptyRow>
        )}
      </Table>
    </section>
  );
}
