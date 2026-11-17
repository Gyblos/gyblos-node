// Owns the chain index writes: set-based, chunked under D1's bound-parameter limit, idempotent (a
// transaction read twice is stored once). u64 amounts are bound as decimal text, which the INTEGER
// columns store exactly. Channel rows merge: parties only from an open, Gyblos once marked stays marked,
// and the last signature only moves forward.
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { DEVNET_GYBLOS_TREASURY } from '@gyblos/config/network';

import { COLLECTOR_LIMITS, GYBLOS_OPEN_MEMOS } from '../constants';
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

const atomic = (value: bigint | null): SQL | null =>
  value === null ? null : sql`${value.toString()}`;
function chunks<T extends object>(rows: readonly T[]): T[][] {
  const columns = Math.max(1, Object.keys(rows[0] ?? {}).length);
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
  cursor: {
    newest: string | null;
    backfillBefore: string | null;
    backfillDone: boolean;
  },
  now: number,
) {
  const values = {
    newestSignature: cursor.newest,
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

// One merged row per channel touched by these transactions.
function channelRows(transactions: ChainTransaction[], now: number) {
  const rows = new Map<string, typeof chainChannels.$inferInsert>();
  for (const tx of transactions) {
    const gyblosMemo = tx.memos.some(isGyblosMemo);
    const paidGyblos = tx.deltas.some(
      (delta) =>
        delta.owner === DEVNET_GYBLOS_TREASURY && delta.deltaAtomic > 0n,
    );
    for (const instruction of tx.instructions) {
      const row = rows.get(instruction.channel) ?? {
        channel: instruction.channel,
        gyblos: 0,
        lastSignature: tx.signature,
        lastSlot: tx.slot,
        updatedAt: now,
      };
      if (instruction.kind === 'open') {
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
      if (instruction.kind === 'distribute' && paidGyblos) row.gyblos = 1;
      if (tx.slot >= row.lastSlot) {
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

export function transactionWrites(
  orm: CollectorDatabase,
  transactions: ChainTransaction[],
  now: number,
): BatchItem[] {
  const txRows = transactions.map((tx) => ({
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTimeMs,
    failed: tx.failed ? 1 : 0,
    memo: tx.memos[0] ?? null,
    indexedAt: now,
  }));
  const instructionRows = transactions.flatMap((tx) =>
    tx.failed
      ? []
      : tx.instructions.map((instruction) => ({
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
  );
  const deltaRows = transactions.flatMap((tx) =>
    tx.failed
      ? []
      : tx.deltas.map((delta) => ({
          signature: tx.signature,
          owner: delta.owner,
          mint: delta.mint,
          deltaAtomic: atomic(delta.deltaAtomic)!,
        })),
  );
  const channels = channelRows(
    transactions.filter((tx) => !tx.failed),
    now,
  );
  return [
    ...chunks(txRows).map((rows) =>
      orm.insert(chainTxs).values(rows).onConflictDoNothing(),
    ),
    ...chunks(instructionRows).map((rows) =>
      orm.insert(chainInstructions).values(rows).onConflictDoNothing(),
    ),
    ...chunks(deltaRows).map((rows) =>
      orm.insert(chainTokenDeltas).values(rows).onConflictDoNothing(),
    ),
    ...chunks(channels).map((rows) =>
      orm
        .insert(chainChannels)
        .values(rows)
        .onConflictDoUpdate({
          target: chainChannels.channel,
          set: {
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
          },
        }),
    ),
  ];
}

// Account state for read channels: what the chain holds now (closed once reclaimed).
export function channelStateUpserts(
  orm: CollectorDatabase,
  states: { channel: string; state: ChannelState }[],
  now: number,
): BatchItem[] {
  const rows = states.map(({ channel, state }) => ({
    channel,
    gyblos: 0,
    lastSignature: '',
    lastSlot: 0,
    status: state.status,
    depositAtomic: atomic(state.depositAtomic),
    settledAtomic: atomic(state.settledAtomic),
    payoutAtomic: atomic(state.payoutAtomic),
    accountReadAt: now,
    updatedAt: now,
  }));
  return chunks(rows).map((chunk) =>
    orm
      .insert(chainChannels)
      .values(chunk)
      .onConflictDoUpdate({
        target: chainChannels.channel,
        set: {
          status: sql`excluded.status`,
          // A closed channel keeps its last known amounts.
          depositAtomic: sql`coalesce(excluded.deposit_atomic, ${chainChannels.depositAtomic})`,
          settledAtomic: sql`coalesce(excluded.settled_atomic, ${chainChannels.settledAtomic})`,
          payoutAtomic: sql`coalesce(excluded.payout_atomic, ${chainChannels.payoutAtomic})`,
          accountReadAt: sql`excluded.account_read_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}
