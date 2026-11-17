// Owns the Payments section: settlements of Gyblos traffic on Solana devnet, their totals, volume
// per day, earnings per seller wallet and the most recent settlements.
import { getChain, type Settlement } from '../lib/chain';
import { EXPLORER_TX } from '../lib/config';
import { DISPLAY, UNITS } from '../lib/constants';
import { short, usdc, utc } from '../lib/format';
import {
  ratioText,
  summarizePayments,
  type DayVolume,
  type SellerEarnings,
} from '../lib/payments';
import {
  Addr,
  moneyCell,
  numberCell,
  SectionTitle,
  Stat,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const blockTimeText = (seconds: number | null) =>
  utc(seconds ? seconds * UNITS.msPerSecond : null);

export async function PaymentsSection() {
  const chain = await getChain();
  if (chain.error) return <Unavailable title="Payments" />;
  const payments = summarizePayments(chain);
  const { settled } = payments;
  return (
    <>
      <SectionTitle
        title="Payments"
        meta={
          chain.pending
            ? `${chain.pending} transactions still loading`
            : `last ${blockTimeText(payments.lastBlockTime)}`
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Settlements" value={String(settled.length)} />
        <Stat label="Paid to sellers" value={usdc(payments.toSellers)} money />
        <Stat label="Gyblos fees" value={usdc(payments.fees)} money />
        <Stat
          label="Effective fee"
          value={ratioText(payments.fees, payments.toSellers)}
        />
        <Stat
          label="Buyers · sellers paid"
          value={`${payments.buyers} · ${payments.earnings.length}`}
        />
        <Stat label="Escrow released" value={usdc(payments.escrow)} money />
        <Stat
          label="Escrow used"
          value={ratioText(payments.spent, payments.escrow)}
        />
        <Stat
          label="Avg paid per settlement"
          value={
            settled.length
              ? usdc(
                  (payments.toSellers + payments.fees) / BigInt(settled.length),
                )
              : '—'
          }
          money
        />
      </div>
      <VolumeChart days={payments.days} max={payments.maxDayPaid} />
      <EarningsTable earnings={payments.earnings} />
      <SettlementsTable settled={settled} />
    </>
  );
}

function barHeight(paid: bigint, max: bigint) {
  const tenths = max === 0n ? 0 : Number((paid * DISPLAY.barScale) / max);
  return Math.max(tenths / DISPLAY.barScaleToPercent, DISPLAY.barMinPercent);
}

function VolumeChart({
  days,
  max,
}: {
  days: [string, DayVolume][];
  max: bigint;
}) {
  if (!days.length) return null;
  return (
    <>
      <SectionTitle title="Volume by day" />
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex h-40 items-end gap-2">
          {days.map(([day, volume]) => (
            <div
              key={day}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${day}: ${volume.count} settlements, ${usdc(volume.paid)}`}
            >
              <span className="font-mono text-[10px] text-dim">
                {volume.count}
              </span>
              <div
                className="w-full max-w-12 rounded-t bg-brand"
                style={{ height: `${barHeight(volume.paid, max)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          {days.map(([day]) => (
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

function EarningsTable({ earnings }: { earnings: [string, SellerEarnings][] }) {
  if (!earnings.length) return null;
  return (
    <>
      <SectionTitle title="Seller earnings" />
      <Table
        head={[
          { label: 'Seller' },
          { label: 'Settlements', right: true },
          { label: 'Earned', right: true },
          { label: 'Fees', right: true },
          { label: 'Last' },
        ]}
      >
        {earnings.map(([wallet, entry]) => (
          <tr key={wallet} className="border-t border-line">
            <td className={`${td} font-mono`}>
              <Addr value={wallet} />
            </td>
            <td className={numberCell}>{entry.count}</td>
            <td className={moneyCell}>{usdc(entry.paid)}</td>
            <td className={moneyCell}>{usdc(entry.fees)}</td>
            <td className={timeCell}>{blockTimeText(entry.last)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function SettlementsTable({ settled }: { settled: Settlement[] }) {
  if (!settled.length) return null;
  return (
    <>
      <SectionTitle title="Settlements" />
      <Table
        minWidth={DISPLAY.wideTable}
        head={[
          { label: 'Time' },
          { label: 'Transaction' },
          { label: 'Buyer' },
          { label: 'Seller' },
          { label: 'To seller', right: true },
          { label: 'Fee', right: true },
          { label: 'Refund', right: true },
        ]}
      >
        {settled.slice(0, DISPLAY.recentSettlements).map((settlement) => (
          <tr key={settlement.signature} className="border-t border-line">
            <td className={timeCell}>{blockTimeText(settlement.blockTime)}</td>
            <td className={`${td} font-mono`}>
              <a
                className="hover:text-brand"
                href={EXPLORER_TX(settlement.signature)}
              >
                {short(
                  settlement.signature,
                  DISPLAY.signatureEdge,
                  DISPLAY.signatureEdge,
                )}
              </a>
            </td>
            <td className={`${td} font-mono`}>
              <Addr value={settlement.payer} />
            </td>
            <td className={`${td} font-mono`}>
              <Addr value={settlement.seller} />
            </td>
            <td className={moneyCell}>{usdc(settlement.sellerAtomic)}</td>
            <td className={moneyCell}>{usdc(settlement.feeAtomic)}</td>
            <td className={`${numberCell} text-muted`}>
              {usdc(settlement.refundAtomic)}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
