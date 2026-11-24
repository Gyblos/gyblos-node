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
  chainHistoryNote,
  dailySettled,
  summarizeChain,
  type ChainSnapshot,
  type ChainSummary,
} from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { ALL_TIME, DISPLAY, PAGING, UNITS } from '../lib/constants';
import { count, settlementCount, usdc, usdcDecimal, utc } from '../lib/format';
import { rangeOf, tablePager, type ExplorerQuery } from '../lib/paging';
import { displayRange, previousRange } from '../lib/range';
import { Flow } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { delta, type Delta } from './board/delta';
import { StatCard } from './board/stat-card';
import { pagedRows, Pager } from './pager';
import {
  amountCell,
  numberCell,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from './ui';

const money = (atomic: bigint) => (
  <Flow value={usdcDecimal(atomic)} kind="usdc" />
);

const meta = (backfillDone: boolean | null, aggregatedAt: number | null) =>
  chainHistoryNote(backfillDone) ?? `updated ${utc(aggregatedAt)}`;

// Each figure's change against the span just before the range; none when it cannot be read or the
// chain history is still being read (an incomplete earlier span would overstate every change).
function changes(current: ChainSummary['totals'], before: ChainSnapshot) {
  if (before.error || !before.backfillDone) return null;
  const previous = summarizeChain(before).totals;
  return {
    settled: [delta(current.settled, previous.settled)],
    paidOut: [delta(current.paidOut, previous.paidOut)],
    gyblosFees: [delta(current.gyblosFees, previous.gyblosFees)],
    opens: [delta(current.opens, previous.opens)],
    deposited: [delta(current.deposited, previous.deposited)],
    refunded: [delta(current.refunded, previous.refunded, 'none')],
  };
}

export async function PaymentsSection({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'payments');
  const [chain, before] = await Promise.all([
    getChainStats(days, 0, query.closed),
    days === ALL_TIME ? null : getChainStats(days, 1, query.closed),
  ]);
  if (chain.error)
    return (
      <Unavailable title="Payments" anchors={[PAGING.anchors.chainDaily]} />
    );
  const summary = summarizeChain(chain);
  const { totals } = summary;
  const change = before ? changes(totals, before) : null;
  return (
    <>
      <SectionTitle
        title={`Payments, ${displayRange(days)}`}
        range={{ section: 'payments', days }}
        meta={
          change
            ? `vs ${previousRange(days)}, ${meta(chain.backfillDone, chain.aggregatedAt)}`
            : meta(chain.backfillDone, chain.aggregatedAt)
        }
      />
      <PaymentStats summary={summary} change={change} />
      <SettledChart
        chain={chain}
        total={totals.settled}
        change={change?.settled[0]}
      />
      <DailyTable
        query={query}
        summary={summary}
        complete={chain.backfillDone === true}
      />
    </>
  );
}

function PaymentStats({
  summary,
  change,
}: {
  summary: ChainSummary;
  change: ReturnType<typeof changes>;
}) {
  const { totals } = summary;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon={Coins}
        label="Settled"
        value={money(totals.settled)}
        deltas={change?.settled}
        money
      />
      <StatCard
        icon={ArrowUpRight}
        label="Paid to sellers"
        value={money(totals.paidOut)}
        deltas={change?.paidOut}
        money
      />
      <StatCard
        icon={Landmark}
        label="Gyblos fees"
        value={money(totals.gyblosFees)}
        deltas={change?.gyblosFees}
        money
      />
      <StatCard
        icon={Percent}
        label="Effective fee"
        hint="Gyblos fees as a share of what buyers paid out: fees divided by fees plus what sellers received."
        value={<Flow value={summary.feeShare} kind="percent" />}
      />
      <StatCard
        icon={Unlock}
        label="Channels opened"
        value={<Flow value={totals.opens} kind="count" />}
        deltas={change?.opens}
      />
      <StatCard
        icon={ArrowDownToLine}
        label="Deposited"
        value={money(totals.deposited)}
        deltas={change?.deposited}
        money
      />
      <StatCard
        icon={Undo2}
        label="Refunded"
        value={money(totals.refunded)}
        deltas={change?.refunded}
      />
      <StatCard
        icon={ListOrdered}
        label="Gyblos transactions"
        value={count(totals.transactions)}
        caption={`of ${count(summary.programTransactions)} in the payments program`}
      />
    </div>
  );
}

// Settled USDC per day; the bar height is approximate, the labels exact.
function SettledChart({
  chain,
  total,
  change,
}: {
  chain: ChainSnapshot;
  total: bigint;
  change?: Delta | null;
}) {
  const points = dailySettled(chain).map((day) => ({
    day: day.day,
    value: Number(day.settled) / UNITS.atomicPerUsdc,
    amount: usdcDecimal(day.settled),
    detail: settlementCount(day.settles),
  }));
  if (!points.length) return null;
  return (
    <div className="mt-4">
      <BarChartCard
        title="Settled per day"
        kind="usdc"
        total={usdcDecimal(total)}
        points={points}
        change={change}
        countAxis={false}
      />
    </div>
  );
}

function DailyTable({
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
    <>
      <SectionTitle id={PAGING.anchors.chainDaily} title="Daily on chain" />
      <Table
        minWidth={DISPLAY.dailyTable}
        sorting={{ query, table: 'chainDaily' }}
        head={[
          { label: 'Day (UTC)', sort: 'day', ascendingFirst: true },
          { label: 'Opens', right: true },
          { label: 'Settlements', right: true },
          { label: 'Settled', right: true, sort: 'settled' },
          { label: 'To sellers', right: true, sort: 'paidOut' },
          { label: 'Fees', right: true },
          { label: 'Refunded', right: true },
          { label: 'All program txs', right: true },
        ]}
        footer={
          <Pager
            label="Daily on chain"
            view={tablePager(query, 'chainDaily', page)}
          />
        }
      >
        {!page.total && (
          <tr>
            <td className={td} colSpan={8}>
              No indexed channel activity in this period.
            </td>
          </tr>
        )}
        {page.rows.map(({ day, gyblos, program }) => (
          <tr key={day} className="border-t border-line">
            <td className={`${td} font-mono`}>{day}</td>
            <td className={numberCell}>{count(gyblos.opens)}</td>
            <td className={numberCell}>{count(gyblos.settles)}</td>
            <td className={amountCell(gyblos.settled)}>
              {usdc(gyblos.settled)}
            </td>
            <td className={amountCell(gyblos.paidOut)}>
              {usdc(gyblos.paidOut)}
            </td>
            <td className={amountCell(gyblos.gyblosFees)}>
              {usdc(gyblos.gyblosFees)}
            </td>
            <td className={`${numberCell} text-muted`}>
              {usdc(gyblos.refunded)}
            </td>
            <td className={`${numberCell} text-muted`}>
              {program ? count(program.transactions) : '—'}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
