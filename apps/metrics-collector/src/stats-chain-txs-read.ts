import { and, desc, eq, inArray, isNotNull, lte, max, sql } from 'drizzle-orm';

import { DEVNET_USDC } from '@gyblos/config/network';

import {
  asInteger,
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
  return orm
    .select({
      signature: ins.signature,
      instructionIndex: ins.instructionIndex,
      slot: chainTxs.slot,
      blockTime: chainTxs.blockTime,
      kind: ins.kind,
      channel: ins.channel,
      payee: chainChannels.payee,
      recipientsJson: chainChannels.recipientsJson,
      mint: chainChannels.mint,
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
    .limit(rows)
    .as('page');
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

function amountOf(
  page: ReturnType<typeof pageKeys>,
  settles: ReturnType<typeof settleIncrements>,
) {
  const firstPaying = sql`not exists (select 1 from ${from(ins, 'e')}
    where ${col('e', ins.signature)} = ${page.signature} and ${col('e', ins.channel)} = ${page.channel}
      and ${col('e', ins.kind)} in ${kinds(PAYING)} and ${col('e', ins.instructionIndex)} < ${page.instructionIndex})`;
  const delta = asInteger(col('d', chainTokenDeltas.deltaAtomic));
  const vaultOut = sql`(select -${delta} from ${from(chainTokenDeltas, 'd')}
    where ${col('d', chainTokenDeltas.signature)} = ${page.signature} and ${col('d', chainTokenDeltas.owner)} = ${page.channel}
      and ${col('d', chainTokenDeltas.mint)} = ${DEVNET_USDC} and ${delta} < 0)`;
  return sql<string | null>`case
    when ${page.mint} is not ${DEVNET_USDC} then null
    when ${page.kind} in ${kinds(DEPOSITING)} then ${page.depositAtomic}
    when ${page.kind} in ${kinds(SETTLING)} then cast(cast(${settles.increment} as integer) as text)
    when ${page.kind} in ${kinds(PAYING)} and ${firstPaying} then cast(${vaultOut} as text)
  end`;
}

export function chainTxReader(database: D1Database): ChainTxReader {
  const orm = createD1Orm(database);
  return {
    transactions: ({ before, rows }) => {
      const page = pageKeys(orm, before, rows);
      const settles = settleIncrements(orm, page);
      return orm
        .select({
          signature: page.signature,
          instructionIndex: page.instructionIndex,
          slot: page.slot,
          blockTime: page.blockTime,
          kind: page.kind,
          channel: page.channel,
          payee: page.payee,
          recipientsJson: page.recipientsJson,
          amountAtomic: amountOf(page, settles),
        })
        .from(page)
        .leftJoin(
          settles,
          and(
            eq(settles.signature, page.signature),
            eq(settles.position, page.instructionIndex),
          ),
        )
        .orderBy(
          desc(page.slot),
          desc(page.signature),
          desc(page.instructionIndex),
        );
    },
  };
}
