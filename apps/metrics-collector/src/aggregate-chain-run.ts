// Owns the chain aggregates' own run: its scan (cursor, dirty marks driven from newly indexed
// transactions through indexes) and the recompute of each dirty day in its own batch, apart from the
// receipt aggregates. It never throws: chain data (anyone can write to the program) can never hold back
// receipt or observation aggregates, nor the chain index that runs after it.
import { desc, eq, sql, type SQL } from 'drizzle-orm';

import { chainDayBatch } from './aggregate-chain';
import {
  col,
  from,
  K,
  kinds,
  SETTLING,
  txJoin,
  type BatchItem,
} from './aggregate-chain-sql';
import { AGG_STATE_ID, AGGREGATES } from './constants';
import type { CollectorDatabase } from './d1-client';
import { dayBounds } from './days';
import {
  aggChainDaily,
  aggChainDirtyDays,
  aggChainState,
  chainInstructions,
  chainTxs,
} from './schema';
import { dayOf, literal, number } from './sql-primitives';

// Marks dirty, in the chain's own dirty set: the days of transactions indexed since `since`; every day
// of a channel a fresh open or distribute names (a late open brings the mint and parties, a distribute
// can add the Gyblos claim); and the days of a channel's settles at or after a fresh settle (history is
// read newest first, so an older settle can arrive after newer ones). A plain new settle or top-up never
// re-marks the channel's whole history.
function chainDirtyMarks(
  database: CollectorDatabase,
  since: number,
): BatchItem[] {
  const fresh = sql`${col('t', chainTxs.indexedAt)} >= ${since}`;
  const day = (alias: string) => dayOf(col(alias, chainTxs.blockTime));
  const mark = (query: SQL) =>
    database.insert(aggChainDirtyDays).select(query).onConflictDoNothing();
  return [
    mark(
      sql`select distinct ${day('t')} from ${from(chainTxs, 't')} where ${fresh} and ${day('t')} is not null`,
    ),
    mark(
      sql`select distinct ${day('o')} from ${from(chainInstructions, 'h')} ${txJoin('h', 'o')}
        where ${col('h', chainInstructions.channel)} in (
          select ${col('i', chainInstructions.channel)} from ${from(chainInstructions, 'i')} ${txJoin('i', 't')}
          where ${fresh} and ${col('i', chainInstructions.kind)} in ${kinds([K.OPEN, K.DISTRIBUTE])}
        ) and ${day('o')} is not null`,
    ),
    // Driven from the fresh transactions (by indexed_at, then each one's instructions), so its cost
    // follows what is new. A fresh settle re-marks the channel's settles from its slot on; a fresh
    // top-up raises the deposit cap of every earlier settle, so it re-marks them all.
    mark(
      sql`select distinct ${day('o')} from (
          select ${col('i', chainInstructions.channel)} as channel,
            min(case when ${col('i', chainInstructions.kind)} = ${literal(K.TOP_UP)} then 0 else ${col('t', chainTxs.slot)} end) as slot
          from ${from(chainTxs, 't')} cross join ${from(chainInstructions, 'i')} on ${col('i', chainInstructions.signature)} = ${col('t', chainTxs.signature)}
          where ${fresh} and ${col('i', chainInstructions.kind)} in ${kinds([...SETTLING, K.TOP_UP])}
          group by ${col('i', chainInstructions.channel)}
        ) as ${sql.identifier('f')}
        join ${from(chainInstructions, 'h')} on ${col('h', chainInstructions.channel)} = ${sql.identifier('f')}.${sql.identifier('channel')}
        ${txJoin('h', 'o')}
        where ${col('h', chainInstructions.kind)} in ${kinds(SETTLING)}
          and ${col('o', chainTxs.slot)} >= ${sql.identifier('f')}.${sql.identifier('slot')}
          and ${day('o')} is not null`,
    ),
  ];
}

// The chain's own scan, apart from the receipt scan: one batch that moves the chain cursor and marks
// dirty days. Before the first chain scan every indexed day is marked; after a formula change, every
// chain day aggregated with another version.
async function chainScan(database: CollectorDatabase, now: number) {
  const [state] = await database
    .select({
      scannedAt: aggChainState.scannedAt,
      formulaVersion: aggChainState.formulaVersion,
    })
    .from(aggChainState)
    .where(eq(aggChainState.id, AGG_STATE_ID));
  const since = state ? state.scannedAt - AGGREGATES.scanOverlapMs : 0;
  const cursor = { scannedAt: now, formulaVersion: AGGREGATES.formulaVersion };
  const changed =
    state !== undefined && state.formulaVersion !== AGGREGATES.formulaVersion;
  await database.batch([
    database
      .insert(aggChainState)
      .values({ id: AGG_STATE_ID, ...cursor })
      .onConflictDoUpdate({ target: aggChainState.id, set: cursor }),
    ...chainDirtyMarks(database, since),
    ...(changed ? [chainStaleMarks(database)] : []),
  ]);
}

// After a formula change, every chain day aggregated with another version.
function chainStaleMarks(database: CollectorDatabase): BatchItem {
  return database
    .insert(aggChainDirtyDays)
    .select(
      sql`select distinct ${aggChainDaily.day} from ${aggChainDaily} where ${aggChainDaily.formulaVersion} <> ${number(AGGREGATES.formulaVersion)}`,
    )
    .onConflictDoNothing();
}

export interface ChainAggregationResult {
  // Chain days recomputed by this run, newest first.
  days: string[];
  // Days whose batch failed; they stay dirty for the next run.
  failed: string[];
  // Dirty days are left for the next run.
  more: boolean;
  // The chain scan or the dirty-day read failed: nothing was recomputed, marks are retried next run.
  scanFailed: boolean;
}

// Scans, then recomputes up to AGGREGATES.maxDaysPerRun chain days, newest first, each in its own batch.
// It never throws: chain data (anyone can write to the program) can never hold back receipt or
// observation aggregates, nor the chain index that runs after it.
export async function runChainAggregation(
  database: CollectorDatabase,
  now: number,
): Promise<ChainAggregationResult> {
  const result: ChainAggregationResult = {
    days: [],
    failed: [],
    more: false,
    scanFailed: false,
  };
  let dirty: { day: string }[];
  try {
    await chainScan(database, now);
    dirty = await database
      .select({ day: aggChainDirtyDays.day })
      .from(aggChainDirtyDays)
      .orderBy(desc(aggChainDirtyDays.day))
      .limit(AGGREGATES.maxDaysPerRun + 1);
  } catch {
    return { ...result, scanFailed: true };
  }
  result.more = dirty.length > AGGREGATES.maxDaysPerRun;
  for (const { day } of dirty.slice(0, AGGREGATES.maxDaysPerRun)) {
    const bounds = dayBounds(day);
    try {
      if (!bounds)
        await database
          .delete(aggChainDirtyDays)
          .where(eq(aggChainDirtyDays.day, day));
      else {
        await database.batch(chainDayBatch(database, bounds, now));
        result.days.push(day);
      }
    } catch {
      result.failed.push(day);
    }
  }
  return result;
}
