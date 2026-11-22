import { and, desc, eq, sql } from 'drizzle-orm';

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
import { createD1Orm, type D1Database } from './d1-client';
import {
  chainChannels,
  chainInstructions,
  chainTokenDeltas,
  chainTxs,
} from './schema';
import type { ChainTxCursor, ChainTxReader } from './stats-chain-txs';

const ins = chainInstructions;
const DEPOSITING = [K.OPEN, K.TOP_UP];
const position = sql`(${chainTxs.slot}, ${ins.signature}, ${ins.instructionIndex})`;

const deposits = sql`(select coalesce(sum(${asInteger(col('dp', ins.amountAtomic))}), 0) from ${from(ins, 'dp')}
  where ${col('dp', ins.channel)} = ${ins.channel} and ${col('dp', ins.kind)} in ${kinds(DEPOSITING)})`;
const settledBefore = sql`(select max(${asInteger(col('p', ins.cumulativeAtomic))}) from ${from(ins, 'p')}
  join ${from(chainTxs, 'pt')} on ${col('pt', chainTxs.signature)} = ${col('p', ins.signature)}
  where ${col('p', ins.channel)} = ${ins.channel} and ${col('p', ins.kind)} in ${kinds(SETTLING)}
    and ${col('p', ins.cumulativeAtomic)} is not null
    and (${col('pt', chainTxs.slot)}, ${col('p', ins.signature)}, ${col('p', ins.instructionIndex)}) < ${position})`;
const settled = sql`max(min(${asInteger(sql`${ins.cumulativeAtomic}`)}, ${deposits}) - min(coalesce(${settledBefore}, 0), ${deposits}), 0)`;
const firstPaying = sql`not exists (select 1 from ${from(ins, 'e')}
  where ${col('e', ins.signature)} = ${ins.signature} and ${col('e', ins.channel)} = ${ins.channel}
    and ${col('e', ins.kind)} in ${kinds(PAYING)} and ${col('e', ins.instructionIndex)} < ${ins.instructionIndex})`;
const vaultOut = sql`(select -${asInteger(col('d', chainTokenDeltas.deltaAtomic))} from ${from(chainTokenDeltas, 'd')}
  where ${col('d', chainTokenDeltas.signature)} = ${ins.signature} and ${col('d', chainTokenDeltas.owner)} = ${ins.channel}
    and ${col('d', chainTokenDeltas.mint)} = ${DEVNET_USDC} and ${asInteger(col('d', chainTokenDeltas.deltaAtomic))} < 0)`;
const amount = sql<string | null>`case
  when ${chainChannels.mint} is not ${DEVNET_USDC} then null
  when ${ins.kind} in ${kinds(DEPOSITING)} then ${ins.amountAtomic}
  when ${ins.kind} in ${kinds(SETTLING)} and ${ins.cumulativeAtomic} is not null then cast(${settled} as text)
  when ${ins.kind} in ${kinds(PAYING)} and ${firstPaying} then cast(${vaultOut} as text)
end`;

const earlierThan = (cursor: ChainTxCursor) =>
  sql`${position} < (${cursor.slot}, ${cursor.signature}, ${cursor.instructionIndex})`;

export function chainTxReader(database: D1Database): ChainTxReader {
  const orm = createD1Orm(database);
  return {
    transactions: ({ before, rows }) =>
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
          amountAtomic: amount,
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
  };
}
