// Owns the chain aggregate formulas (#349): each dirty day gets one row per scope, the whole program
// (counts from its signature list) and channels claiming Gyblos traffic (read in full), recomputed
// from the chain index in one batch. Amounts count devnet USDC only and are stored as decimal text.
// The run that schedules it is aggregate-chain-run.ts.
import { desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  DEVNET_GYBLOS_TREASURY,
  DEVNET_TREASURY_OWNER,
  DEVNET_USDC,
} from '@gyblos/config/network';

import {
  asInteger,
  atomicTotal,
  channelJoin,
  col,
  from,
  inDay,
  inScope,
  K,
  kinds,
  PAYING,
  SETTLING,
  txJoin,
  type BatchItem,
} from './aggregate-chain-sql';
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
  chainProgramDaily,
  chainTokenDeltas,
  chainTxs,
} from './schema';
import { dayOf, literal, number } from './sql-primitives';

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

// Read transactions (all of them Gyblos: opens with a Gyblos memo, then followed channels) with a
// program instruction the decoder could not read. Failed program transactions are counted in the
// program row, from the signature list.
function transactionTotals(bounds: DayBounds) {
  return sql`(select 0 as failed,
      count(case when ${col('t', chainTxs.failed)} = 0 and ${col('t', chainTxs.undecodable)} > 0 then 1 end) as undecodable
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

export function payoutParts() {
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
  const payer = sql`(${named(chainChannels.payer)} or ${owner} in (select ${col('ip', chainInstructions.payer)} from ${from(chainInstructions, 'ip')}
    where ${col('ip', chainInstructions.signature)} = ${signature} and ${col('ip', chainInstructions.kind)} in ${kinds(PAYING)}
      and ${col('ip', chainInstructions.payer)} is not null))`;
  const toPayer = sql`not ${treasury} and ${payer}`;
  const toOthers = sql`not ${treasury} and not ${payer} and (${named(chainChannels.payee)} or ${recipient})`;
  const vault = sql`(select total(-${asInteger(col('v', chainTokenDeltas.deltaAtomic))}) from ${from(chainTokenDeltas, 'v')}
    where ${col('v', chainTokenDeltas.signature)} = ${signature} and ${col('v', chainTokenDeltas.mint)} = ${DEVNET_USDC}
      and ${asInteger(col('v', chainTokenDeltas.deltaAtomic))} < 0
      and ${col('v', chainTokenDeltas.owner)} in (select ${col('vi', chainInstructions.channel)} from ${from(chainInstructions, 'vi')} where ${col('vi', chainInstructions.signature)} = ${signature}))`;
  const part = (condition: SQL) =>
    sql`total(case when ${condition} then ${amount} end)`;
  const otherChannelPaid = sql`(
        select 1 from ${from(chainInstructions, 'y')} ${channelJoin('y', 'yc')}
        where ${col('y', chainInstructions.signature)} = ${signature}
          and ${col('y', chainInstructions.kind)} in ${kinds(PAYING)}
          and coalesce(${col('yc', chainChannels.gyblos)}, 0) <> 1
      )`;
  const balanced = (parts: { g: SQL; pt: SQL; r: SQL; o: SQL; outflow: SQL }) =>
    sql`${parts.g} + ${parts.pt} + ${parts.r} + ${parts.o} <= ${parts.outflow}`;
  return {
    signature,
    amount,
    toGyblos,
    toProgram,
    toPayer,
    toOthers,
    vault,
    part,
    otherChannelPaid,
    balanced,
  };
}

// What the day's distribute and reclaim transactions paid in USDC, by who received it. Only owners the
// transaction's channels name count: the Gyblos and program treasuries, a channel's payer or payee, a
// distribute recipient. A transaction whose payouts exceed what left its channels' vaults (a transfer
// bundled with the payout) counts none, so payouts never exceed money the program released. Payouts
// are per transaction, so in the gyblos scope a transaction counts only when every paying instruction
// in it is for a Gyblos channel.
export function payoutTransactions(
  bounds: Pick<DayBounds, 'start' | 'end'>,
  scope: ChainAggregateScope,
) {
  const {
    signature,
    amount,
    toGyblos,
    toProgram,
    toPayer,
    toOthers,
    vault,
    part,
    otherChannelPaid,
    balanced,
  } = payoutParts();
  const perTx = sql`(select ${col('t', chainTxs.blockTime)} as at,
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
      and not exists ${otherChannelPaid}`
          : sql``
      }
    group by ${signature})`;
  const shown = (name: string) =>
    atomicTotal(
      sql`case when ${balanced({ g: sql.raw('g'), pt: sql.raw('pt'), r: sql.raw('r'), o: sql.raw('o'), outflow: sql.raw('vault') })} then ${sql.identifier(name)} end`,
    );
  return { perTx, shown };
}

function payoutTotals(bounds: DayBounds, scope: ChainAggregateScope) {
  const { perTx, shown } = payoutTransactions(bounds, scope);
  return sql`(select
      ${shown('g')} as gyblos_fees,
      ${shown('pt')} as program_treasury,
      ${shown('r')} as refunded,
      ${shown('o')} as paid_out
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
    from ${instructionTotals(bounds, scope)}, ${transactionTotals(bounds)}, ${settledTotal(bounds, scope)}, ${payoutTotals(bounds, scope)}
    where ${field('ins', 'transactions')} + ${field('tx', 'failed')} + ${field('tx', 'undecodable')} > 0`;
}

// The whole program's row: counts from its signature list, no transaction read. Every other column is
// zero (the program's traffic is not read in full); a day the list never covered has no row.
function programRow(bounds: DayBounds, now: number): SQL {
  const zero = sql`0`;
  const none = sql`'0'`;
  const version = versionFields(now);
  const fields = fieldList(aggChainDaily, {
    day: sql`${bounds.day}`,
    scope: literal(CHAIN_AGGREGATE_SCOPES.PROGRAM),
    transactions: sql`${chainProgramDaily.transactions}`,
    failed: sql`${chainProgramDaily.failed}`,
    undecodable: zero,
    opens: zero,
    settles: zero,
    topUps: zero,
    settleAndSeals: zero,
    requestCloses: zero,
    seals: zero,
    distributes: zero,
    reclaims: zero,
    channels: zero,
    payers: zero,
    payees: zero,
    depositedAtomic: none,
    settledAtomic: none,
    gyblosFeesAtomic: none,
    programTreasuryAtomic: none,
    refundedAtomic: none,
    paidOutAtomic: none,
    formulaVersion: version.formulaVersion,
    aggregatedAt: version.aggregatedAt,
  });
  return sql`select ${fields} from ${chainProgramDaily} where ${chainProgramDaily.day} = ${bounds.day}`;
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
    database.insert(aggChainDaily).select(programRow(bounds, now)),
    database
      .insert(aggChainDaily)
      .select(scopeRow(bounds, CHAIN_AGGREGATE_SCOPES.GYBLOS, now)),
  ];
}
