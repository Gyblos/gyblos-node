// Owns the public chain stats use case: GET /v1/stats/chain turns the daily chain rows into what the
// payment-channels program did per day, for the whole program and for channels that claim Gyblos
// traffic (a claim anyone can make). Settled USDC and fees come only from here, never from receipts.
import { CHANNEL_PROGRAM, DEVNET, DEVNET_USDC } from '@gyblos/config/network';

import { CHAIN_AGGREGATE_SCOPES } from './constants';
import { daysOf, type DayRange } from './days';
import { envelope, fromRow, groupBy, type StatsEnvelope } from './stats';
import type { ChainDayRow, ChainIndexState, StatsReader } from './stats-store';

export interface ChainSection {
  // Successful transactions with at least one instruction in scope.
  transactions: number;
  instructions: {
    open: number;
    settle: number;
    topUp: number;
    settleAndSeal: number;
    requestClose: number;
    seal: number;
    distribute: number;
    reclaim: number;
  };
  channels: number;
  payers: number;
  payees: number;
  // USDC atomic units as decimal text, devnet USDC channels only.
  usdc: {
    depositedAtomic: string;
    settledAtomic: string;
    gyblosFeesAtomic: string;
    programTreasuryAtomic: string;
    refundedAtomic: string;
    paidOutAtomic: string;
  };
}
export interface ChainDay {
  day: string;
  // Null when the program had no activity that day.
  program: (ChainSection & { failed: number; undecodable: number }) | null;
  // Channels that claim Gyblos traffic: a self-declared label anyone can set, not verified traffic.
  // Null when no such channel had activity that day.
  gyblosClaimed: ChainSection | null;
}
export interface ChainStats extends StatsEnvelope {
  network: string;
  programId: string;
  mint: string;
  index: ChainIndexState | null;
  days: ChainDay[];
}

function section(row: ChainDayRow): ChainSection {
  return {
    transactions: row.transactions,
    instructions: {
      open: row.opens,
      settle: row.settles,
      topUp: row.topUps,
      settleAndSeal: row.settleAndSeals,
      requestClose: row.requestCloses,
      seal: row.seals,
      distribute: row.distributes,
      reclaim: row.reclaims,
    },
    channels: row.channels,
    payers: row.payers,
    payees: row.payees,
    usdc: {
      depositedAtomic: row.depositedAtomic,
      settledAtomic: row.settledAtomic,
      gyblosFeesAtomic: row.gyblosFeesAtomic,
      programTreasuryAtomic: row.programTreasuryAtomic,
      refundedAtomic: row.refundedAtomic,
      paidOutAtomic: row.paidOutAtomic,
    },
  };
}

export async function chainStats(
  reader: StatsReader,
  range: DayRange,
): Promise<ChainStats> {
  const { days, index } = await reader.chain(range);
  const byDay = groupBy(days, (row) => row.day);
  return {
    ...envelope(range, days.map(fromRow)),
    network: DEVNET,
    programId: CHANNEL_PROGRAM,
    mint: DEVNET_USDC,
    index,
    days: daysOf(range).map((day): ChainDay => {
      const rows = byDay.get(day) ?? [];
      const program = rows.find(
        (row) => row.scope === CHAIN_AGGREGATE_SCOPES.PROGRAM,
      );
      const gyblos = rows.find(
        (row) => row.scope === CHAIN_AGGREGATE_SCOPES.GYBLOS,
      );
      return {
        day,
        program: program
          ? {
              ...section(program),
              failed: program.failed,
              undecodable: program.undecodable,
            }
          : null,
        gyblosClaimed: gyblos ? section(gyblos) : null,
      };
    }),
  };
}
