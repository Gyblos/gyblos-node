import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { CHAIN_CURSOR_ID } from '../constants';
import type { CollectorDatabase } from '../d1-client';
import { chainCursor } from '../schema';

export type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];

export const owned = (lease: number | null) =>
  sql`exists (select 1 from ${chainCursor} where ${chainCursor.id} = ${CHAIN_CURSOR_ID} and ${chainCursor.leaseUntil} = ${lease})`;

const tuples = (
  table: SQLiteTable,
  rows: readonly Record<string, unknown>[],
) => {
  const keys = Object.keys(getTableColumns(table));
  return sql.join(
    rows.map((row) => {
      if (
        Object.keys(row).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(row, key))
      )
        throw new TypeError('write row does not match its table');
      return sql`(${sql.join(
        keys.map((key) => sql`${row[key]}`),
        sql`, `,
      )})`;
    }),
    sql`, `,
  );
};

export const ownedInsert = <T extends SQLiteTable>(
  orm: CollectorDatabase,
  table: T,
  chunk: Record<string, unknown>[],
  lease: number | null,
) =>
  orm
    .insert(table)
    .select(
      sql`select * from (values ${tuples(table, chunk)}) where ${owned(lease)}`,
    );

const leaseRead = (orm: CollectorDatabase) =>
  orm
    .select({ leaseUntil: chainCursor.leaseUntil })
    .from(chainCursor)
    .where(eq(chainCursor.id, CHAIN_CURSOR_ID));

export async function ownedBatch(
  orm: CollectorDatabase,
  items: readonly BatchItem[],
  lease: number | null,
): Promise<boolean> {
  const results: unknown = await orm.batch([leaseRead(orm), ...items]);
  if (!Array.isArray(results) || !Array.isArray(results[0])) return false;
  const row: unknown = results[0][0];
  if (typeof row !== 'object' || row === null) return false;
  const leaseUntil = (row as { leaseUntil?: unknown }).leaseUntil;
  return lease !== null && leaseUntil === lease;
}
