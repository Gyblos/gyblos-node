// Owns the chain index writes: set-based, idempotent (a transaction read twice is stored once) and
// chunked by the table's column count, so no statement passes D1's bound-parameter limit whatever the
// rows hold. Amounts are exact decimal text. Channel rows merge: parties only from an open, a Gyblos
// claim once made stays, the last signature only moves forward.
import { getTableColumns, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { DEVNET_GYBLOS_TREASURY } from '@gyblos/config/network';

import {
  CHAIN_CHANNEL_CLOSED,
  CHAIN_CURSOR_ID,
  CHAIN_INSTRUCTIONS,
  COLLECTOR_LIMITS,
  GYBLOS_OPEN_MEMOS,
} from '../constants';
import type { CollectorDatabase } from '../d1-client';
import { dayOfTime } from '../days';
import {
  aggChainDirtyDays,
  chainChannels,
  chainCursor,
  chainInstructions,
  chainProgramDaily,
  chainTokenDeltas,
  chainTxs,
} from '../schema';
import type { ChannelState } from './channel-account';
import type { ChainTransaction } from './decode';
import { owned, ownedInsert, type BatchItem } from './owned';
import type { ChainSignature } from './rpc';

export interface ChainCursorState {
  newest: string | null;
  newestSlot: number | null;
  gapUntil: string | null;
  gapBefore: string | null;
  gapUntilSlot: number | null;
  // The page that last moved the range was full: an empty answer may mean the range is done.
  gapFull: boolean;
  backfillBefore: string | null;
  backfillFull: boolean;
  backfillDone: boolean;
}

const atomic = (value: bigint | null) =>
  value === null ? null : value.toString();
// Rows per statement so every column of `table` fits under the parameter limit.
function chunksFor<T>(
  table: SQLiteTable,
  rows: readonly T[],
  reserved = 0,
): T[][] {
  const columns = Object.keys(getTableColumns(table)).length;
  const size = Math.max(
    1,
    Math.floor((COLLECTOR_LIMITS.maxBoundParameters - reserved) / columns),
  );
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size)
    result.push(rows.slice(start, start + size));
  return result;
}

export function cursorUpdate(
  orm: CollectorDatabase,
  cursor: ChainCursorState,
  now: number,
  lease: number | null,
) {
  return orm
    .update(chainCursor)
    .set({
      newestSignature: cursor.newest,
      newestSlot: cursor.newestSlot,
      gapUntil: cursor.gapUntil,
      gapUntilSlot: cursor.gapUntilSlot,
      gapBefore: cursor.gapBefore,
      gapFull: cursor.gapFull ? 1 : 0,
      backfillBefore: cursor.backfillBefore,
      backfillFull: cursor.backfillFull ? 1 : 0,
      backfillDone: cursor.backfillDone ? 1 : 0,
      updatedAt: now,
    })
    .where(
      sql`${chainCursor.id} = ${CHAIN_CURSOR_ID} and ${chainCursor.leaseUntil} = ${lease}`,
    );
}

const isGyblosMemo = (memo: string) =>
  GYBLOS_OPEN_MEMOS.some((prefix) => memo.startsWith(prefix));
// A signature list's memo ("[length] text", several joined by "; ") carries a Gyblos open memo.
export function listsGyblosMemo(memo: string | null): boolean {
  if (!memo) return false;
  return memo
    .split('; ')
    .some((part) => isGyblosMemo(part.replace(/^\[\d+\] /, '')));
}
type ChannelRow = typeof chainChannels.$inferInsert;
const blankChannel = (
  channel: string,
  signature: string,
  slot: number,
  now: number,
): ChannelRow => ({
  channel,
  payer: null,
  payee: null,
  mint: null,
  authorizedSigner: null,
  salt: null,
  openSlot: null,
  openedAt: null,
  gyblos: 0,
  recipientsJson: null,
  depositAtomic: null,
  settledAtomic: null,
  payoutAtomic: null,
  status: null,
  lastSignature: signature,
  lastSlot: slot,
  accountReadAt: null,
  updatedAt: now,
  following: 0,
  followUntil: null,
  followedAt: null,
});

// One merged row per channel the successful transactions name (every row has every column).
function channelRows(transactions: ChainTransaction[], now: number) {
  const rows = new Map<string, ChannelRow>();
  for (const tx of transactions) {
    const gyblosMemo = tx.memos.some(isGyblosMemo);
    const paidGyblos = tx.deltas.some(
      (delta) =>
        delta.owner === DEVNET_GYBLOS_TREASURY && delta.deltaAtomic > 0n,
    );
    for (const instruction of tx.instructions) {
      const row =
        rows.get(instruction.channel) ??
        blankChannel(instruction.channel, tx.signature, tx.slot, now);
      if (instruction.kind === CHAIN_INSTRUCTIONS.OPEN) {
        Object.assign(row, {
          payer: instruction.payer,
          payee: instruction.payee,
          mint: instruction.mint,
          authorizedSigner: instruction.authorizedSigner,
          salt: instruction.salt,
          openSlot: instruction.openSlot,
          openedAt: tx.blockTimeMs,
          recipientsJson: JSON.stringify(instruction.recipients),
        });
        // A Gyblos open starts following the channel from this signature on.
        if (gyblosMemo)
          Object.assign(row, {
            gyblos: 1,
            following: 1,
            followUntil: tx.signature,
          });
      }
      if (instruction.kind === CHAIN_INSTRUCTIONS.DISTRIBUTE && paidGyblos)
        row.gyblos = 1;
      if (tx.slot >= row.lastSlot!) {
        row.lastSignature = tx.signature;
        row.lastSlot = tx.slot;
      }
      rows.set(instruction.channel, row);
    }
  }
  return [...rows.values()];
}

// The incoming value when it has one, else the stored one.
const keep = (column: SQLiteColumn) =>
  sql`coalesce(excluded.${sql.identifier(column.name)}, ${column})`;
const channelMerge = {
  payer: keep(chainChannels.payer),
  payee: keep(chainChannels.payee),
  mint: keep(chainChannels.mint),
  authorizedSigner: keep(chainChannels.authorizedSigner),
  salt: keep(chainChannels.salt),
  openSlot: keep(chainChannels.openSlot),
  openedAt: keep(chainChannels.openedAt),
  recipientsJson: keep(chainChannels.recipientsJson),
  gyblos: sql`max(${chainChannels.gyblos}, excluded.gyblos)`,
  lastSignature: sql`case when excluded.last_slot >= ${chainChannels.lastSlot} then excluded.last_signature else ${chainChannels.lastSignature} end`,
  lastSlot: sql`max(${chainChannels.lastSlot}, excluded.last_slot)`,
  updatedAt: sql`excluded.updated_at`,
  // Following starts once; progress already made through the channel's list is kept.
  following: sql`max(${chainChannels.following}, excluded.following)`,
  followUntil: sql`coalesce(${chainChannels.followUntil}, excluded.follow_until)`,
};

function rowsOf(transactions: ChainTransaction[], now: number) {
  const succeeded = transactions.filter((tx) => !tx.failed);
  return {
    txs: transactions.map((tx) => ({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTimeMs,
      failed: tx.failed ? 1 : 0,
      undecodable: tx.undecodable,
      memo: tx.memos[0] ?? null,
      indexedAt: now,
    })),
    instructions: succeeded.flatMap((tx) =>
      tx.instructions.map((instruction) => ({
        signature: tx.signature,
        instructionIndex: instruction.index,
        kind: instruction.kind,
        channel: instruction.channel,
        payer: instruction.payer,
        payee: instruction.payee,
        mint: instruction.mint,
        amountAtomic: atomic(instruction.amountAtomic),
        cumulativeAtomic: atomic(instruction.cumulativeAtomic),
        recipientsJson: instruction.recipients
          ? JSON.stringify(instruction.recipients)
          : null,
      })),
    ),
    deltas: succeeded.flatMap((tx) =>
      tx.deltas.map((delta) => ({
        signature: tx.signature,
        owner: delta.owner,
        mint: delta.mint,
        deltaAtomic: delta.deltaAtomic.toString(),
      })),
    ),
    channels: channelRows(succeeded, now),
  };
}

export function transactionWrites(
  orm: CollectorDatabase,
  transactions: ChainTransaction[],
  now: number,
  lease: number | null,
): BatchItem[] {
  const rows = rowsOf(transactions, now);
  return [
    ...chunksFor(chainTxs, rows.txs, 2).map((chunk) =>
      ownedInsert(orm, chainTxs, chunk, lease).onConflictDoNothing(),
    ),
    ...chunksFor(chainInstructions, rows.instructions, 2).map((chunk) =>
      ownedInsert(orm, chainInstructions, chunk, lease).onConflictDoNothing(),
    ),
    ...chunksFor(chainTokenDeltas, rows.deltas, 2).map((chunk) =>
      ownedInsert(orm, chainTokenDeltas, chunk, lease).onConflictDoNothing(),
    ),
    ...chunksFor(chainChannels, rows.channels, 2).map((chunk) =>
      ownedInsert(orm, chainChannels, chunk, lease).onConflictDoUpdate({
        target: chainChannels.channel,
        set: channelMerge,
      }),
    ),
  ];
}

// Account state for channels the index already stored (rows exist: they come from stored
// instructions). A closed or unknown channel keeps its last known amounts.
export function channelStateUpserts(
  orm: CollectorDatabase,
  states: { channel: string; state: ChannelState }[],
  now: number,
  lease: number | null,
): BatchItem[] {
  const rows = states.map(({ channel, state }) => ({
    ...blankChannel(channel, '', 0, now),
    status: state.status,
    depositAtomic: atomic(state.depositAtomic),
    settledAtomic: atomic(state.settledAtomic),
    payoutAtomic: atomic(state.payoutAtomic),
    accountReadAt: now,
  }));
  return chunksFor(chainChannels, rows, 2).map((chunk) =>
    ownedInsert(orm, chainChannels, chunk, lease).onConflictDoUpdate({
      target: chainChannels.channel,
      set: {
        status: sql`excluded.status`,
        depositAtomic: sql`coalesce(excluded.deposit_atomic, ${chainChannels.depositAtomic})`,
        settledAtomic: sql`coalesce(excluded.settled_atomic, ${chainChannels.settledAtomic})`,
        payoutAtomic: sql`coalesce(excluded.payout_atomic, ${chainChannels.payoutAtomic})`,
        accountReadAt: sql`excluded.account_read_at`,
        updatedAt: sql`excluded.updated_at`,
        // A closed channel is no longer followed.
        following: sql`case when excluded.status = ${CHAIN_CHANNEL_CLOSED} then 0 else ${chainChannels.following} end`,
      },
    }),
  );
}

// Program-wide counts of a stored stretch of the program's signature list, by UTC day of block time,
// with the days marked dirty for the chain aggregates. Each signature is counted once: the caller
// writes these in the same batch as the list cursor that covers them.
export function programCounts(
  orm: CollectorDatabase,
  entries: readonly ChainSignature[],
  now: number,
  lease: number | null,
): BatchItem[] {
  const days = new Map<string, { transactions: number; failed: number }>();
  for (const entry of entries) {
    if (entry.blockTimeMs === null) continue;
    const day = dayOfTime(entry.blockTimeMs);
    const counts = days.get(day) ?? { transactions: 0, failed: 0 };
    counts.transactions += 1;
    if (entry.failed) counts.failed += 1;
    days.set(day, counts);
  }
  const rows = [...days].map(([day, counts]) => ({
    day,
    ...counts,
    updatedAt: now,
  }));
  return [
    ...chunksFor(chainProgramDaily, rows, 2).map((chunk) =>
      ownedInsert(orm, chainProgramDaily, chunk, lease).onConflictDoUpdate({
        target: chainProgramDaily.day,
        set: {
          transactions: sql`${chainProgramDaily.transactions} + excluded.transactions`,
          failed: sql`${chainProgramDaily.failed} + excluded.failed`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
    ),
    ...chunksFor(aggChainDirtyDays, rows, 2).map((chunk) =>
      ownedInsert(
        orm,
        aggChainDirtyDays,
        chunk.map(({ day }) => ({ day })),
        lease,
      ).onConflictDoNothing(),
    ),
  ];
}

// Moves a followed channel's cursor (the newest signature read from its list) and poll time; a channel
// whose list floods past one page in a poll is no longer followed.
export function followUpdate(
  orm: CollectorDatabase,
  channel: string,
  follow: { until: string | null; following: boolean },
  now: number,
  lease: number | null,
): BatchItem {
  return orm
    .update(chainChannels)
    .set({
      followUntil: follow.until,
      following: follow.following ? 1 : 0,
      followedAt: now,
    })
    .where(sql`${chainChannels.channel} = ${channel} and ${owned(lease)}`);
}
