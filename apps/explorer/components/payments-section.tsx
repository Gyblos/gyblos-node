// Owns the Payments section: what Gyblos channels moved on Solana devnet, from the collector's chain
// index (GET /v1/stats/chain): settled USDC, payouts to sellers, Gyblos fees, refunds, volume per day,
// and the whole program's traffic for scale. Gyblos traffic is a label the channel's open declares.
import {
  dailySettled,
  summarizeChain,
  type ChainSnapshot,
  type ChainSummary,
} from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { DISPLAY, UNITS } from '../lib/constants';
import { count, percent, usdc, utc } from '../lib/format';
import type { RangeDays } from '../lib/range';
import { BarChartCard } from './board/bar-chart-card';
import {
  moneyCell,
  numberCell,
  SectionTitle,
  Stat,
  Table,
  td,
  Unavailable,
} from './ui';

function meta(backfillDone: boolean | null, aggregatedAt: number | null) {
  if (backfillDone === null) return 'chain index starting';
  if (!backfillDone) return 'reading chain history';
  return `updated ${utc(aggregatedAt)}`;
}

export async function PaymentsSection({ days }: { days: RangeDays }) {
  const chain = await getChainStats(days);
  if (chain.error) return <Unavailable title="Payments" />;
  const summary = summarizeChain(chain);
  const { totals } = summary;
  return (
    <>
      <SectionTitle
        title={`Payments · ${days} days`}
        meta={meta(chain.backfillDone, chain.aggregatedAt)}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Settled" value={usdc(totals.settled)} money />
        <Stat label="Paid to sellers" value={usdc(totals.paidOut)} money />
        <Stat label="Gyblos fees" value={usdc(totals.gyblosFees)} money />
        <Stat
          label="Effective fee"
          value={summary.feeShare === null ? '—' : percent(summary.feeShare)}
        />
        <Stat label="Channels opened" value={count(totals.opens)} />
        <Stat label="Deposited" value={usdc(totals.deposited)} money />
        <Stat label="Refunded" value={usdc(totals.refunded)} money />
        <Stat
          label="Gyblos · program txs"
          value={`${count(totals.transactions)} · ${count(summary.programTransactions)}`}
        />
      </div>
      <SettledChart chain={chain} total={usdc(totals.settled)} />
      <DailyTable summary={summary} />
      <p className="mt-4 text-xs text-dim">
        Gyblos channels are those whose open carries a Gyblos memo, a label
        anyone can set. The program is shared: its other traffic is only
        counted.
      </p>
    </>
  );
}

// Settled USDC per day; the bar height is approximate, the labels exact.
function SettledChart({
  chain,
  total,
}: {
  chain: ChainSnapshot;
  total: string;
}) {
  const points = dailySettled(chain).map((day) => ({
    day: day.day,
    value: Number(day.settled) / UNITS.atomicPerUsdc,
    label: `${usdc(day.settled)} · ${count(day.settles)} settlements`,
  }));
  if (!points.length) return null;
  return (
    <div className="mt-4">
      <BarChartCard
        title="Settled per day"
        total={total}
        points={points}
        countAxis={false}
      />
    </div>
  );
}

function DailyTable({ summary }: { summary: ChainSummary }) {
  if (!summary.days.length) return null;
  return (
    <>
      <SectionTitle title="Daily on chain" />
      <Table
        minWidth={DISPLAY.dailyTable}
        head={[
          { label: 'Day (UTC)' },
          { label: 'Opens', right: true },
          { label: 'Settlements', right: true },
          { label: 'Settled', right: true },
          { label: 'To sellers', right: true },
          { label: 'Fees', right: true },
          { label: 'Refunded', right: true },
          { label: 'Program txs', right: true },
        ]}
      >
        {[...summary.days].reverse().map(({ day, gyblos, program }) => (
          <tr key={day} className="border-t border-line">
            <td className={`${td} font-mono`}>{day}</td>
            <td className={numberCell}>{count(gyblos.opens)}</td>
            <td className={numberCell}>{count(gyblos.settles)}</td>
            <td className={moneyCell}>{usdc(gyblos.settled)}</td>
            <td className={moneyCell}>{usdc(gyblos.paidOut)}</td>
            <td className={moneyCell}>{usdc(gyblos.gyblosFees)}</td>
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
