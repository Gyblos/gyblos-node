// Owns the chain index writes: set-based, idempotent (a transaction read twice is stored once) and
// chunked by the table's column count, so no statement passes D1's bound-parameter limit whatever the
// rows hold. Amounts are exact decimal text. Channel rows merge: parties only from an open, a Gyblos
// claim once made stays, the last signature only moves forward.
import { getTableColumns, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { DEVNET_GYBLOS_TREASURY } from '@gyblos/config/network';

import {
  CHAIN_INSTRUCTIONS,
  COLLECTOR_LIMITS,
  GYBLOS_OPEN_MEMOS,
} from '../constants';
import type { CollectorDatabase } from '../d1-client';
import {
  chainChannels,
  chainCursor,
  chainInstructions,
  chainTokenDeltas,
  chainTxs,
} from '../schema';
import type { ChannelState } from './channel-account';
import type { ChainTransaction } from './decode';

type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];
export interface ChainCursorState {
  newest: string | null;
  gapUntil: string | null;
  gapBefore: string | null;
  backfillBefore: string | null;
  backfillDone: boolean;
}

const atomic = (value: bigint | null) =>
  value === null ? null : value.toString();
// Rows per statement so every column of `table` fits under the parameter limit.
function chunksFor<T>(table: SQLiteTable, rows: readonly T[]): T[][] {
  const columns = Object.keys(getTableColumns(table)).length;
  const size = Math.max(
    1,
    Math.floor(COLLECTOR_LIMITS.maxBoundParameters / columns),
  );
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size)
    result.push(rows.slice(start, start + size));
  return result;
}

export function cursorUpsert(
  orm: CollectorDatabase,
  id: number,
  cursor: ChainCursorState,
  now: number,
) {
  const values = {
    newestSignature: cursor.newest,
    gapUntil: cursor.gapUntil,
    gapBefore: cursor.gapBefore,
    backfillBefore: cursor.backfillBefore,
    backfillDone: cursor.backfillDone ? 1 : 0,
    updatedAt: now,
  };
  return orm
    .insert(chainCursor)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: chainCursor.id, set: values });
}

const isGyblosMemo = (memo: string) =>
  GYBLOS_OPEN_MEMOS.some((prefix) => memo.startsWith(prefix));
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
        if (gyblosMemo) row.gyblos = 1;
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
): BatchItem[] {
  const rows = rowsOf(transactions, now);
  return [
    ...chunksFor(chainTxs, rows.txs).map((chunk) =>
      orm.insert(chainTxs).values(chunk).onConflictDoNothing(),
    ),
    ...chunksFor(chainInstructions, rows.instructions).map((chunk) =>
      orm.insert(chainInstructions).values(chunk).onConflictDoNothing(),
    ),
    ...chunksFor(chainTokenDeltas, rows.deltas).map((chunk) =>
      orm.insert(chainTokenDeltas).values(chunk).onConflictDoNothing(),
    ),
    ...chunksFor(chainChannels, rows.channels).map((chunk) =>
      orm
        .insert(chainChannels)
        .values(chunk)
        .onConflictDoUpdate({
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
): BatchItem[] {
  const rows = states.map(({ channel, state }) => ({
    ...blankChannel(channel, '', 0, now),
    status: state.status,
    depositAtomic: atomic(state.depositAtomic),
    settledAtomic: atomic(state.settledAtomic),
    payoutAtomic: atomic(state.payoutAtomic),
    accountReadAt: now,
  }));
  return chunksFor(chainChannels, rows).map((chunk) =>
    orm
      .insert(chainChannels)
      .values(chunk)
      .onConflictDoUpdate({
        target: chainChannels.channel,
        set: {
          status: sql`excluded.status`,
          depositAtomic: sql`coalesce(excluded.deposit_atomic, ${chainChannels.depositAtomic})`,
          settledAtomic: sql`coalesce(excluded.settled_atomic, ${chainChannels.settledAtomic})`,
          payoutAtomic: sql`coalesce(excluded.payout_atomic, ${chainChannels.payoutAtomic})`,
          accountReadAt: sql`excluded.account_read_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}
