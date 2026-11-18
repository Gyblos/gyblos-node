// Owns the shape of the collector's chain stats (GET /v1/stats/chain, gyblos-node
// docs/metrics-collector.md) and their summary: what the payment-channels program carried per day, and
// the full detail of channels that claim Gyblos traffic. Checked at the boundary; amounts stay exact
// as bigint. Pure, no I/O.
import { UNITS } from './constants';
import {
  flag,
  integerText,
  list,
  nullable,
  num,
  record,
  text,
  type JsonRecord,
} from './validate';

export interface ChainSection {
  transactions: number;
  opens: number;
  settles: number;
  distributes: number;
  reclaims: number;
  channels: number;
  payers: number;
  payees: number;
  deposited: bigint;
  settled: bigint;
  gyblosFees: bigint;
  programTreasury: bigint;
  refunded: bigint;
  paidOut: bigint;
}
export interface ChainDay {
  day: string;
  // The whole program (anyone's traffic): counted, never read in full.
  program: { transactions: number; failed: number } | null;
  // Channels that claim Gyblos traffic (a self-declared label).
  gyblos: ChainSection | null;
}
export interface ChainSnapshot {
  aggregatedAt: number | null;
  // Whether the program's history is fully read; null before the index ever ran.
  backfillDone: boolean | null;
  days: ChainDay[];
  error: string | null;
}

const amount = (usdc: JsonRecord, key: string) =>
  BigInt(integerText(usdc[key], `chain.usdc.${key}`));
function parseSection(value: unknown): ChainSection {
  const section = record(value, 'chain.gyblosClaimed');
  const kinds = record(section.instructions, 'chain.instructions');
  const usdc = record(section.usdc, 'chain.usdc');
  const kind = (key: string) => num(kinds[key], `chain.instructions.${key}`);
  return {
    transactions: num(section.transactions, 'chain.transactions'),
    opens: kind('open'),
    settles: kind('settle') + kind('settleAndSeal'),
    distributes: kind('distribute'),
    reclaims: kind('reclaim'),
    channels: num(section.channels, 'chain.channels'),
    payers: num(section.payers, 'chain.payers'),
    payees: num(section.payees, 'chain.payees'),
    deposited: amount(usdc, 'depositedAtomic'),
    settled: amount(usdc, 'settledAtomic'),
    gyblosFees: amount(usdc, 'gyblosFeesAtomic'),
    programTreasury: amount(usdc, 'programTreasuryAtomic'),
    refunded: amount(usdc, 'refundedAtomic'),
    paidOut: amount(usdc, 'paidOutAtomic'),
  };
}

export function parseChainStats(value: unknown): Omit<ChainSnapshot, 'error'> {
  const body = record(value, 'chain');
  const index = nullable(body.index, (present) =>
    record(present, 'chain.index'),
  );
  return {
    aggregatedAt: nullable(body.aggregatedAt, (present) =>
      num(present, 'chain.aggregatedAt'),
    ),
    backfillDone: index
      ? flag(index.backfillDone, 'chain.index.backfillDone')
      : null,
    days: list(body.days, 'chain.days').map((entry) => {
      const day = record(entry, 'chain.day');
      return {
        day: text(day.day, 'chain.day.day'),
        program: nullable(day.program, (present) => {
          const program = record(present, 'chain.program');
          return {
            transactions: num(
              program.transactions,
              'chain.program.transactions',
            ),
            failed: num(program.failed, 'chain.program.failed'),
          };
        }),
        gyblos: nullable(day.gyblosClaimed, parseSection),
      };
    }),
  };
}

export interface ChainSummary {
  totals: ChainSection;
  programTransactions: number;
  // Gyblos fees over what the payouts carried (fees plus paid to sellers); null without payouts.
  feeShare: number | null;
  // Days with Gyblos activity, oldest first.
  days: (ChainDay & { gyblos: ChainSection })[];
  maxDaySettled: bigint;
}

const empty = (): ChainSection => ({
  transactions: 0,
  opens: 0,
  settles: 0,
  distributes: 0,
  reclaims: 0,
  channels: 0,
  payers: 0,
  payees: 0,
  deposited: 0n,
  settled: 0n,
  gyblosFees: 0n,
  programTreasury: 0n,
  refunded: 0n,
  paidOut: 0n,
});

// Sums the range. Distinct counts (channels, payers, payees) are per day and cannot be added across
// days: the totals keep the largest daily value as a lower bound.
export function summarizeChain(snapshot: ChainSnapshot): ChainSummary {
  const totals = empty();
  let programTransactions = 0;
  const days: ChainSummary['days'] = [];
  let maxDaySettled = 0n;
  for (const day of snapshot.days) {
    programTransactions += day.program?.transactions ?? 0;
    const gyblos = day.gyblos;
    if (!gyblos) continue;
    days.push({ ...day, gyblos });
    if (gyblos.settled > maxDaySettled) maxDaySettled = gyblos.settled;
    for (const key of [
      'transactions',
      'opens',
      'settles',
      'distributes',
      'reclaims',
    ] as const)
      totals[key] += gyblos[key];
    for (const key of ['channels', 'payers', 'payees'] as const)
      totals[key] = Math.max(totals[key], gyblos[key]);
    for (const key of [
      'deposited',
      'settled',
      'gyblosFees',
      'programTreasury',
      'refunded',
      'paidOut',
    ] as const)
      totals[key] += gyblos[key];
  }
  const charged = totals.gyblosFees + totals.paidOut;
  return {
    totals,
    programTransactions,
    feeShare: charged
      ? Number((totals.gyblosFees * BigInt(UNITS.ratioScale)) / charged) /
        UNITS.ratioScale
      : null,
    days,
    maxDaySettled,
  };
}
