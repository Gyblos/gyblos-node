// Owns the Payments section: what Gyblos channels moved on Solana devnet, from the collector's chain
// index (GET /v1/stats/chain): settled USDC, payouts to sellers, Gyblos fees, refunds, volume per day,
// and the whole program's traffic for scale. Gyblos traffic is a label the channel's open declares.
import { summarizeChain, type ChainSummary } from '../lib/chain-shape';
import { getChainStats } from '../lib/chain-stats';
import { DISPLAY } from '../lib/constants';
import { count, percent, usdc, utc } from '../lib/format';
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

export async function PaymentsSection() {
  const chain = await getChainStats();
  if (chain.error) return <Unavailable title="Payments" />;
  const summary = summarizeChain(chain);
  const { totals } = summary;
  return (
    <>
      <SectionTitle
        title="Payments · 30 days"
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
      <VolumeChart summary={summary} />
      <DailyTable summary={summary} />
      <p className="mt-4 text-xs text-dim">
        Gyblos channels are those whose open carries a Gyblos memo, a label
        anyone can set. The program is shared: its other traffic is only
        counted.
      </p>
    </>
  );
}

function barHeight(value: bigint, max: bigint) {
  const tenths = max === 0n ? 0 : Number((value * DISPLAY.barScale) / max);
  return Math.max(tenths / DISPLAY.barScaleToPercent, DISPLAY.barMinPercent);
}

function VolumeChart({ summary }: { summary: ChainSummary }) {
  const days = summary.days.slice(-DISPLAY.chartDays);
  if (!days.length) return null;
  return (
    <>
      <SectionTitle title="Settled by day" />
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex h-40 items-end gap-2">
          {days.map(({ day, gyblos }) => (
            <div
              key={day}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${day}: ${usdc(gyblos.settled)} settled, ${gyblos.settles} settlements`}
            >
              <span className="font-mono text-[10px] text-dim">
                {gyblos.settles}
              </span>
              <div
                className="w-full max-w-12 rounded-t bg-brand"
                style={{
                  height: `${barHeight(gyblos.settled, summary.maxDaySettled)}%`,
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          {days.map(({ day }) => (
            <span
              key={day}
              className="min-w-0 flex-1 truncate text-center font-mono text-[10px] text-dim"
            >
              {day.slice(DISPLAY.monthDayStart)}
            </span>
          ))}
        </div>
      </div>
    </>
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
