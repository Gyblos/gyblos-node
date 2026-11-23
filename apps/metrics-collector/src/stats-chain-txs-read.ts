import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  max,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { DEVNET_USDC } from '@gyblos/config/network';

import { payoutParts } from './aggregate-chain';
import {
  asInteger,
  channelJoin,
  col,
  from,
  K,
  kinds,
  PAYING,
  SETTLING,
} from './aggregate-chain-sql';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from './d1-client';
import {
  chainChannels,
  chainInstructions,
  chainTokenDeltas,
  chainTxs,
} from './schema';
import { literal } from './sql-primitives';
import type { ChainTxCursor, ChainTxReader } from './stats-chain-txs';

const ins = chainInstructions;
const DEPOSITING = [K.OPEN, K.TOP_UP];

const earlierThan = (cursor: ChainTxCursor) =>
  sql`(${chainTxs.slot}, ${ins.signature}, ${ins.instructionIndex}) < (${cursor.slot}, ${cursor.signature}, ${cursor.instructionIndex})`;

function pageKeys(
  orm: CollectorDatabase,
  before: ChainTxCursor | null,
  rows: number,
) {
  return orm.$with('page').as(
    orm
      .select({
        signature: ins.signature,
        instructionIndex: ins.instructionIndex,
        slot: chainTxs.slot,
        blockTime: chainTxs.blockTime,
        kind: ins.kind,
        channel: ins.channel,
        payee: chainChannels.payee,
        recipientsJson: chainChannels.recipientsJson,
        mint: sql<
          string | null
        >`coalesce(${chainChannels.mint}, ${ins.mint})`.as('mint'),
        depositAtomic: ins.amountAtomic,
        cumulativeAtomic: ins.cumulativeAtomic,
      })
      .from(ins)
      .innerJoin(chainTxs, eq(chainTxs.signature, ins.signature))
      .innerJoin(chainChannels, eq(chainChannels.channel, ins.channel))
      .where(
        and(
          eq(chainChannels.gyblos, 1),
          eq(chainTxs.failed, 0),
          before ? earlierThan(before) : undefined,
        ),
      )
      .orderBy(
        desc(chainTxs.slot),
        desc(ins.signature),
        desc(ins.instructionIndex),
      )
      .limit(rows),
  );
}

function settleIncrements(
  orm: CollectorDatabase,
  page: ReturnType<typeof pageKeys>,
) {
  const pageChannels = orm
    .select({ channel: page.channel })
    .from(page)
    .where(inArray(page.kind, SETTLING));
  const newestSlot = orm.select({ slot: max(page.slot) }).from(page);
  const deposits = orm
    .select({
      channel: ins.channel,
      amount: sql<number>`total(${asInteger(sql`${ins.amountAtomic}`)})`.as(
        'amount',
      ),
    })
    .from(ins)
    .where(
      and(inArray(ins.kind, DEPOSITING), inArray(ins.channel, pageChannels)),
    )
    .groupBy(ins.channel)
    .as('deposits');
  const capped = sql`min(${asInteger(sql`${ins.cumulativeAtomic}`)}, ${deposits.amount})`;
  const highest = sql`max(${capped}) over (partition by ${ins.channel} order by ${chainTxs.slot}, ${capped}, ${ins.signature}, ${ins.instructionIndex} rows between unbounded preceding and 1 preceding)`;
  return orm
    .select({
      signature: ins.signature,
      position: sql<number>`${ins.instructionIndex}`.as('position'),
      increment: sql<number>`max(${capped} - coalesce(${highest}, 0), 0)`.as(
        'increment',
      ),
    })
    .from(ins)
    .innerJoin(chainTxs, eq(chainTxs.signature, ins.signature))
    .innerJoin(chainChannels, eq(chainChannels.channel, ins.channel))
    .innerJoin(deposits, eq(deposits.channel, ins.channel))
    .where(
      and(
        inArray(ins.kind, SETTLING),
        isNotNull(ins.cumulativeAtomic),
        isNotNull(chainTxs.blockTime),
        eq(chainChannels.mint, DEVNET_USDC),
        inArray(ins.channel, pageChannels),
        lte(chainTxs.slot, newestSlot),
      ),
    )
    .as('settles');
}

const usdcMint = (instruction: string, channel: string) =>
  sql`coalesce(${col(channel, chainChannels.mint)}, ${col(instruction, ins.mint)}) = ${DEVNET_USDC}`;

function payoutSplits(
  orm: CollectorDatabase,
  page: ReturnType<typeof pageKeys>,
) {
  const deltas = alias(chainTokenDeltas, 'd');
  const parts = payoutParts();
  const paying = orm
    .select({ signature: page.signature })
    .from(page)
    .where(inArray(page.kind, PAYING));
  const channels = sql`(select count(distinct ${col('n', ins.channel)}) from ${from(ins, 'n')} ${channelJoin('n', 'nc')}
    where ${col('n', ins.signature)} = ${parts.signature} and ${col('n', ins.kind)} in ${kinds(PAYING)} and ${usdcMint('n', 'nc')})`;
  return orm
    .select({
      signature: sql<string>`${parts.signature}`.as('split_signature'),
      gyblosFees: parts.part(parts.toGyblos).as('gyblos_fees'),
      programTreasury: parts.part(parts.toProgram).as('program_treasury'),
      refunded: parts.part(parts.toPayer).as('refunded'),
      paidOut: parts.part(parts.toOthers).as('paid_out'),
      vault: sql<number>`max(${parts.vault})`.as('vault'),
      channels: sql<number>`max(${channels})`.as('channels'),
    })
    .from(deltas)
    .where(
      and(
        inArray(deltas.signature, paying),
        eq(deltas.mint, DEVNET_USDC),
        gt(parts.amount, 0),
        sql`not exists ${parts.otherChannelPaid}`,
      ),
    )
    .groupBy(deltas.signature)
    .as('splits');
}

function payoutFields(
  page: ReturnType<typeof pageKeys>,
  splits: ReturnType<typeof payoutSplits>,
) {
  const firstPaying = sql`not exists (select 1 from ${from(ins, 'e')} ${channelJoin('e', 'ec')}
    where ${col('e', ins.signature)} = ${page.signature} and ${usdcMint('e', 'ec')}
      and ${col('e', ins.kind)} in ${kinds(PAYING)} and ${col('e', ins.instructionIndex)} < ${page.instructionIndex})`;
  const balanced = payoutParts().balanced({
    g: sql`${splits.gyblosFees}`,
    pt: sql`${splits.programTreasury}`,
    r: sql`${splits.refunded}`,
    o: sql`${splits.paidOut}`,
    outflow: sql`${splits.vault}`,
  });
  const when = sql`${page.mint} is ${DEVNET_USDC} and ${page.kind} in ${kinds(PAYING)} and ${firstPaying} and ${balanced}`;
  const shown = (value: SQL | SQL.Aliased) =>
    sql<
      string | null
    >`case when ${when} then cast(cast(${value} as integer) as text) end`;
  const unclassified = sql`${splits.vault} - (${splits.gyblosFees} + ${splits.programTreasury} + ${splits.refunded} + ${splits.paidOut})`;
  return {
    unclassified: shown(unclassified),
    paidOut: shown(splits.paidOut),
    gyblosFees: shown(splits.gyblosFees),
    programTreasury: shown(splits.programTreasury),
    refunded: shown(splits.refunded),
    channels: sql<number | null>`case when ${when} then ${splits.channels} end`,
  };
}

function amountOf(
  page: ReturnType<typeof pageKeys>,
  settles: ReturnType<typeof settleIncrements>,
  payout: ReturnType<typeof payoutFields>,
) {
  return sql<string | null>`case
    when ${page.mint} is not ${DEVNET_USDC} then null
    when ${page.kind} in ${kinds(DEPOSITING)} then ${page.depositAtomic}
    when ${page.kind} in ${kinds(SETTLING)} then cast(cast(${settles.increment} as integer) as text)
    when ${page.kind} = ${literal(K.DISTRIBUTE)} then ${payout.paidOut}
    when ${page.kind} = ${literal(K.RECLAIM)} then ${payout.refunded}
  end`;
}

export function chainTxReader(database: D1Database): ChainTxReader {
  const orm = createD1Orm(database);
  return {
    transactions: ({ before, rows }) => {
      const page = pageKeys(orm, before, rows);
      const settles = settleIncrements(orm, page);
      const splits = payoutSplits(orm, page);
      const payout = payoutFields(page, splits);
      return orm
        .with(page)
        .select({
          signature: page.signature,
          instructionIndex: page.instructionIndex,
          slot: page.slot,
          blockTime: page.blockTime,
          kind: page.kind,
          channel: page.channel,
          payee: page.payee,
          recipientsJson: page.recipientsJson,
          amountAtomic: amountOf(page, settles, payout),
          splitPaidOut: payout.paidOut.as('split_paid_out'),
          splitGyblosFees: payout.gyblosFees.as('split_gyblos_fees'),
          splitProgramTreasury: payout.programTreasury.as(
            'split_program_treasury',
          ),
          splitRefunded: payout.refunded.as('split_refunded'),
          splitChannels: payout.channels.as('split_channels'),
          splitUnclassified: payout.unclassified.as('split_unclassified'),
        })
        .from(page)
        .leftJoin(
          settles,
          and(
            eq(settles.signature, page.signature),
            eq(settles.position, page.instructionIndex),
          ),
        )
        .leftJoin(splits, eq(splits.signature, page.signature))
        .orderBy(
          desc(page.slot),
          desc(page.signature),
          desc(page.instructionIndex),
        );
    },
  };
}
