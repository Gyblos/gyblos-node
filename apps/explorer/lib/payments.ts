// Owns the sums the Payments section shows over settlements read from Solana: totals, the share of
// escrow used, earnings per seller wallet and volume per UTC day.
import type { ChainSnapshot, Settlement } from './chain';
import { UNITS } from './constants';
import { percent } from './format';

// Escrow released by a settlement: everything paid out of the channel in that transaction.
const released = (settlement: Settlement) =>
  settlement.sellerAtomic +
  settlement.feeAtomic +
  settlement.residualAtomic +
  settlement.refundAtomic;
const used = (settlement: Settlement) =>
  settlement.sellerAtomic + settlement.feeAtomic + settlement.residualAtomic;

export function ratioText(part: bigint, whole: bigint): string {
  if (whole === 0n) return '—';
  const scale = BigInt(UNITS.ratioScale);
  return percent(Number((part * scale) / whole) / UNITS.ratioScale);
}

export interface SellerEarnings {
  count: number;
  paid: bigint;
  fees: bigint;
  last: number;
}
function earningsBySeller(settled: Settlement[]) {
  const bySeller = new Map<string, SellerEarnings>();
  for (const settlement of settled) {
    if (!settlement.seller) continue;
    const entry = bySeller.get(settlement.seller) ?? {
      count: 0,
      paid: 0n,
      fees: 0n,
      last: 0,
    };
    entry.count += 1;
    entry.paid += settlement.sellerAtomic;
    entry.fees += settlement.feeAtomic;
    entry.last = Math.max(entry.last, settlement.blockTime ?? 0);
    bySeller.set(settlement.seller, entry);
  }
  return bySeller;
}

export interface DayVolume {
  count: number;
  paid: bigint;
}
function volumeByDay(settled: Settlement[]) {
  const byDay = new Map<string, DayVolume>();
  for (const settlement of settled) {
    if (!settlement.blockTime) continue;
    const key = new Date(settlement.blockTime * UNITS.msPerSecond)
      .toISOString()
      .split('T')[0]!;
    const entry = byDay.get(key) ?? { count: 0, paid: 0n };
    entry.count += 1;
    entry.paid += settlement.sellerAtomic + settlement.feeAtomic;
    byDay.set(key, entry);
  }
  return [...byDay].sort((left, right) => (left[0] < right[0] ? -1 : 1));
}

export function summarizePayments(chain: ChainSnapshot) {
  const settled = chain.settlements.filter(
    (settlement) => settlement.kind === 'settlement',
  );
  const sum = (amount: (settlement: Settlement) => bigint) =>
    settled.reduce((total, settlement) => total + amount(settlement), 0n);
  const bySeller = earningsBySeller(settled);
  const days = volumeByDay(settled);
  return {
    settled,
    toSellers: sum((settlement) => settlement.sellerAtomic),
    fees: sum((settlement) => settlement.feeAtomic),
    escrow: sum(released),
    spent: sum(used),
    buyers: new Set(
      settled.map((settlement) => settlement.payer).filter(Boolean),
    ).size,
    lastBlockTime: settled[0]?.blockTime ?? null,
    earnings: [...bySeller].sort((left, right) =>
      right[1].paid > left[1].paid ? 1 : -1,
    ),
    days,
    maxDayPaid: days.reduce(
      (max, [, volume]) => (volume.paid > max ? volume.paid : max),
      0n,
    ),
  };
}
