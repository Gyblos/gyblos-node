// Owns the chain aggregates (#349): their dirty marks, the per-day formulas and their own run. Each
// dirty day gets one row per scope (whole program, channels claiming Gyblos traffic) recomputed from
// the chain index, in a batch apart from the receipt aggregates. Amounts count devnet USDC only and
// are stored as decimal text.
import { desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  DEVNET_GYBLOS_TREASURY,
  DEVNET_TREASURY_OWNER,
  DEVNET_USDC,
} from '@gyblos/config/network';

import { versionFields } from './aggregate-sql';
import {
  AGG_STATE_ID,
  AGGREGATES,
  CHAIN_AGGREGATE_SCOPES,
  CHAIN_INSTRUCTIONS,
  type ChainAggregateScope,
  type ChainInstructionKind,
} from './constants';
import type { CollectorDatabase } from './d1-client';
import { dayBounds, type DayBounds } from './days';
import {
  aggChainDaily,
  aggChainDirtyDays,
  aggChainState,
  chainChannels,
  chainInstructions,
  chainTokenDeltas,
  chainTxs,
} from './schema';
import { dayOf, literal, number } from './sql-primitives';

type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];
const K = CHAIN_INSTRUCTIONS;
const SETTLING: ChainInstructionKind[] = [K.SETTLE, K.SETTLE_AND_SEAL];
const PAYING: ChainInstructionKind[] = [K.DISTRIBUTE, K.RECLAIM];

// `alias.column`, always qualified: these statements read the same tables under several aliases.
const col = (alias: string, column: SQLiteColumn) =>
  sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
const from = (table: SQLiteTable, alias: string) =>
  sql`${table} as ${sql.identifier(alias)}`;
const kinds = (values: readonly ChainInstructionKind[]) =>
  sql`(${sql.join(values.map(literal), sql`, `)})`;
const asInteger = (value: SQL) => sql`cast(${value} as integer)`;
// A sum as decimal integer text; 0 over no rows. SQLite total() never fails on overflow (one huge
// value can never make a day fail) and is exact below 2^53 atomic units (9e9 USDC).
const atomicTotal = (value: SQL) =>
  sql`cast(cast(total(${value}) as integer) as text)`;
// The block time of transaction alias `alias` falls in the day.
const inDay = (alias: string, bounds: DayBounds) =>
  sql`${col(alias, chainTxs.blockTime)} >= ${number(bounds.start)} and ${col(alias, chainTxs.blockTime)} < ${number(bounds.end)}`;
// Channel alias `alias` is in scope (left-joined: an unknown channel is never a Gyblos one).
const inScope = (alias: string, scope: ChainAggregateScope) =>
  scope === CHAIN_AGGREGATE_SCOPES.GYBLOS
    ? sql`${col(alias, chainChannels.gyblos)} = 1`
    : sql`1 = 1`;
const txJoin = (instruction: string, tx: string) =>
  sql`join ${from(chainTxs, tx)} on ${col(tx, chainTxs.signature)} = ${col(instruction, chainInstructions.signature)}`;
const channelJoin = (instruction: string, channel: string, left = true) =>
  sql`${sql.raw(left ? 'left join' : 'join')} ${from(chainChannels, channel)} on ${col(channel, chainChannels.channel)} = ${col(instruction, chainInstructions.channel)}`;

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

// Counts and deposits of the day's instructions in scope.
function instructionTotals(bounds: DayBounds, scope: ChainAggregateScope) {
  const kind = col('i', chainInstructions.kind);
  const countKind = (value: ChainInstructionKind) =>
    sql`count(case when ${kind} = ${literal(value)} then 1 end)`;
  return sql`(select
      count(distinct ${col('i', chainInstructions.signature)}) as transactions,
      ${countKind(K.OPEN)} as opens,
      ${countKind(K.SETTLE)} as settles,
      ${countKind(K.TOP_UP)} as top_ups,
      ${countKind(K.SETTLE_AND_SEAL)} as settle_and_seals,
      ${countKind(K.REQUEST_CLOSE)} as request_closes,
      ${countKind(K.SEAL)} as seals,
      ${countKind(K.DISTRIBUTE)} as distributes,
      ${countKind(K.RECLAIM)} as reclaims,
      count(distinct ${col('i', chainInstructions.channel)}) as channels,
      count(distinct ${col('c', chainChannels.payer)}) as payers,
      count(distinct ${col('c', chainChannels.payee)}) as payees,
      ${atomicTotal(sql`case when ${kind} in ${kinds([K.OPEN, K.TOP_UP])} and ${col('c', chainChannels.mint)} = ${DEVNET_USDC} then ${asInteger(col('i', chainInstructions.amountAtomic))} end`)} as deposited
    from ${from(chainInstructions, 'i')} ${txJoin('i', 't')} ${channelJoin('i', 'c')}
    where ${inDay('t', bounds)} and ${inScope('c', scope)}) as ins`;
}

// Failed and undecodable transactions name no channel: counted in the program scope only.
function transactionTotals(bounds: DayBounds, scope: ChainAggregateScope) {
  if (scope !== CHAIN_AGGREGATE_SCOPES.PROGRAM)
    return sql`(select 0 as failed, 0 as undecodable) as tx`;
  const failed = col('t', chainTxs.failed);
  return sql`(select
      count(case when ${failed} = 1 then 1 end) as failed,
      count(case when ${failed} = 0 and ${col('t', chainTxs.undecodable)} > 0 then 1 end) as undecodable
    from ${from(chainTxs, 't')} where ${inDay('t', bounds)}) as tx`;
}

// New settled amount of the day: each settle's cumulative above the highest one the channel settled
// before it, in chain order (the address derives from the open slot, so a channel is never reopened).
// A cumulative that does not pass the running maximum adds nothing, so alternating vouchers never
// inflate the total.
function settledTotal(bounds: DayBounds, scope: ChainAggregateScope) {
  const id = (name: string) => sql.identifier(name);
  // The channels that settled this day; only their history is read.
  const settledToday = sql`(select ${col('i', chainInstructions.channel)} from ${from(chainInstructions, 'i')} ${txJoin('i', 't')}
    where ${inDay('t', bounds)} and ${col('i', chainInstructions.kind)} in ${kinds(SETTLING)})`;
  // A voucher never counts past the channel's deposits (open plus top-ups): a self-signed cumulative
  // cannot settle money the channel never held. Computed once per channel, then joined.
  const deposits = sql`(select ${col('dp', chainInstructions.channel)} as channel, total(${asInteger(col('dp', chainInstructions.amountAtomic))}) as amount
    from ${from(chainInstructions, 'dp')}
    where ${col('dp', chainInstructions.kind)} in ${kinds([K.OPEN, K.TOP_UP])} and ${col('dp', chainInstructions.channel)} in ${settledToday}
    group by ${col('dp', chainInstructions.channel)}) as ${id('dep')}`;
  const settles = sql`(select ${col('s', chainInstructions.channel)} as channel, ${col('u', chainTxs.slot)} as slot,
      ${col('s', chainInstructions.signature)} as signature, ${col('s', chainInstructions.instructionIndex)} as position,
      ${col('u', chainTxs.blockTime)} as at, ${col('v', chainChannels.gyblos)} as gyblos,
      min(${asInteger(col('s', chainInstructions.cumulativeAtomic))}, ${id('dep')}.${id('amount')}) as cumulative
    from ${from(chainInstructions, 's')} ${txJoin('s', 'u')} ${channelJoin('s', 'v', false)}
      join ${deposits} on ${id('dep')}.${id('channel')} = ${col('s', chainInstructions.channel)}
    where ${col('s', chainInstructions.kind)} in ${kinds(SETTLING)}
      and ${col('s', chainInstructions.cumulativeAtomic)} is not null
      and ${col('v', chainChannels.mint)} = ${DEVNET_USDC}
      and ${col('u', chainTxs.blockTime)} < ${number(bounds.end)}
      and ${col('s', chainInstructions.channel)} in ${settledToday})`;
  const highest = sql`max(cumulative) over (partition by channel order by slot, cumulative, signature, position rows between unbounded preceding and 1 preceding)`;
  return sql`(select ${atomicTotal(sql`${id('increment')}`)} as settled from (
      select at, gyblos, max(cumulative - coalesce(${highest}, 0), 0) as increment from ${settles}
    ) where at >= ${number(bounds.start)}${
      scope === CHAIN_AGGREGATE_SCOPES.GYBLOS ? sql` and gyblos = 1` : sql``
    }) as st`;
}

// What the day's distribute and reclaim transactions paid in USDC, by who received it. Only owners the
// transaction's channels name count: the Gyblos and program treasuries, a channel's payer or payee, a
// distribute recipient. A transaction whose payouts exceed what left its channels' vaults (a transfer
// bundled with the payout) counts none, so payouts never exceed money the program released. Payouts
// are per transaction, so in the gyblos scope a transaction counts only when every paying instruction
// in it is for a Gyblos channel.
function payoutTotals(bounds: DayBounds, scope: ChainAggregateScope) {
  const owner = col('d', chainTokenDeltas.owner);
  const signature = col('d', chainTokenDeltas.signature);
  const amount = asInteger(col('d', chainTokenDeltas.deltaAtomic));
  // A party of a channel the transaction names.
  const named = (column: SQLiteColumn) =>
    sql`${owner} in (select ${col('pc', column)} from ${from(chainInstructions, 'pi')} ${channelJoin('pi', 'pc', false)} where ${col('pi', chainInstructions.signature)} = ${signature} and ${col('pc', column)} is not null)`;
  const recipient = sql`exists (select 1 from ${from(chainInstructions, 'ri')}, json_each(${col('ri', chainInstructions.recipientsJson)}) as ${sql.identifier('rj')}
    where ${col('ri', chainInstructions.signature)} = ${signature} and ${col('ri', chainInstructions.kind)} = ${literal(K.DISTRIBUTE)}
      and json_extract(${sql.identifier('rj')}.${sql.identifier('value')}, '$.owner') = ${owner})`;
  const toGyblos = sql`${owner} = ${DEVNET_GYBLOS_TREASURY}`;
  const toProgram = sql`${owner} = ${DEVNET_TREASURY_OWNER}`;
  const treasury = sql`(${toGyblos} or ${toProgram})`;
  const toPayer = sql`not ${treasury} and ${named(chainChannels.payer)}`;
  const toOthers = sql`not ${treasury} and not ${named(chainChannels.payer)} and (${named(chainChannels.payee)} or ${recipient})`;
  const vault = sql`(select total(-${asInteger(col('v', chainTokenDeltas.deltaAtomic))}) from ${from(chainTokenDeltas, 'v')}
    where ${col('v', chainTokenDeltas.signature)} = ${signature} and ${col('v', chainTokenDeltas.mint)} = ${DEVNET_USDC}
      and ${asInteger(col('v', chainTokenDeltas.deltaAtomic))} < 0
      and ${col('v', chainTokenDeltas.owner)} in (select ${col('vi', chainInstructions.channel)} from ${from(chainInstructions, 'vi')} where ${col('vi', chainInstructions.signature)} = ${signature}))`;
  const part = (condition: SQL) =>
    sql`total(case when ${condition} then ${amount} end)`;
  const perTx = sql`(select
      ${part(toGyblos)} as g, ${part(toProgram)} as pt, ${part(toPayer)} as r, ${part(toOthers)} as o,
      ${vault} as vault
    from ${from(chainTokenDeltas, 'd')} join ${from(chainTxs, 't')} on ${col('t', chainTxs.signature)} = ${signature}
    where ${inDay('t', bounds)}
      and ${col('d', chainTokenDeltas.mint)} = ${DEVNET_USDC}
      and ${amount} > 0
      and exists (
        select 1 from ${from(chainInstructions, 'x')} ${channelJoin('x', 'c')}
        where ${col('x', chainInstructions.signature)} = ${signature}
          and ${col('x', chainInstructions.kind)} in ${kinds(PAYING)}
          and ${inScope('c', scope)}
      )${
        scope === CHAIN_AGGREGATE_SCOPES.GYBLOS
          ? sql`
      and not exists (
        select 1 from ${from(chainInstructions, 'y')} ${channelJoin('y', 'yc')}
        where ${col('y', chainInstructions.signature)} = ${signature}
          and ${col('y', chainInstructions.kind)} in ${kinds(PAYING)}
          and coalesce(${col('yc', chainChannels.gyblos)}, 0) <> 1
      )`
          : sql``
      }
    group by ${signature})`;
  const balanced = (name: string) =>
    atomicTotal(
      sql`case when g + pt + r + o <= vault then ${sql.identifier(name)} end`,
    );
  return sql`(select
      ${balanced('g')} as gyblos_fees,
      ${balanced('pt')} as program_treasury,
      ${balanced('r')} as refunded,
      ${balanced('o')} as paid_out
    from ${perTx}) as dl`;
}

// One SELECT field per table column, in the table's order (Drizzle inserts positionally).
function fieldList(table: SQLiteTable, fields: Record<string, SQL>) {
  const columns = getTableColumns(table);
  if (Object.keys(fields).join() !== Object.keys(columns).join())
    throw new Error('Aggregate fields do not match the table column order.');
  return sql.join(
    Object.entries(fields).map(
      ([key, value]) => sql`${value} as ${sql.identifier(columns[key]!.name)}`,
    ),
    sql`, `,
  );
}

function scopeRow(
  bounds: DayBounds,
  scope: ChainAggregateScope,
  now: number,
): SQL {
  const field = (alias: string, name: string) =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const version = versionFields(now);
  const fields = fieldList(aggChainDaily, {
    day: sql`${bounds.day}`,
    scope: literal(scope),
    transactions: field('ins', 'transactions'),
    failed: field('tx', 'failed'),
    undecodable: field('tx', 'undecodable'),
    opens: field('ins', 'opens'),
    settles: field('ins', 'settles'),
    topUps: field('ins', 'top_ups'),
    settleAndSeals: field('ins', 'settle_and_seals'),
    requestCloses: field('ins', 'request_closes'),
    seals: field('ins', 'seals'),
    distributes: field('ins', 'distributes'),
    reclaims: field('ins', 'reclaims'),
    channels: field('ins', 'channels'),
    payers: field('ins', 'payers'),
    payees: field('ins', 'payees'),
    depositedAtomic: field('ins', 'deposited'),
    settledAtomic: field('st', 'settled'),
    gyblosFeesAtomic: field('dl', 'gyblos_fees'),
    programTreasuryAtomic: field('dl', 'program_treasury'),
    refundedAtomic: field('dl', 'refunded'),
    paidOutAtomic: field('dl', 'paid_out'),
    formulaVersion: version.formulaVersion,
    aggregatedAt: version.aggregatedAt,
  });
  // A day with no chain activity in scope gets no row.
  return sql`select ${fields}
    from ${instructionTotals(bounds, scope)}, ${transactionTotals(bounds, scope)}, ${settledTotal(bounds, scope)}, ${payoutTotals(bounds, scope)}
    where ${field('ins', 'transactions')} + ${field('tx', 'failed')} + ${field('tx', 'undecodable')} > 0`;
}

// The day's chain rows, replaced for every scope; the day leaves the chain dirty set with them.
export function chainDayBatch(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
): [BatchItem, ...BatchItem[]] {
  return [
    database
      .delete(aggChainDirtyDays)
      .where(eq(aggChainDirtyDays.day, bounds.day)),
    database.delete(aggChainDaily).where(eq(aggChainDaily.day, bounds.day)),
    ...Object.values(CHAIN_AGGREGATE_SCOPES).map((scope) =>
      database.insert(aggChainDaily).select(scopeRow(bounds, scope, now)),
    ),
  ];
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
