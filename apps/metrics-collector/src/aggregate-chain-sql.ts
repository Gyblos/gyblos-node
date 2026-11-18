// Owns the SQL building blocks of the chain aggregates: instruction kinds, qualified aliases (the
// statements read the same tables under several aliases), day and scope conditions and exact sums.
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  CHAIN_AGGREGATE_SCOPES,
  CHAIN_INSTRUCTIONS,
  type ChainAggregateScope,
  type ChainInstructionKind,
} from './constants';
import type { CollectorDatabase } from './d1-client';
import type { DayBounds } from './days';
import { chainChannels, chainInstructions, chainTxs } from './schema';
import { literal, number } from './sql-primitives';

export type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];
export const K = CHAIN_INSTRUCTIONS;
export const SETTLING: ChainInstructionKind[] = [K.SETTLE, K.SETTLE_AND_SEAL];
export const PAYING: ChainInstructionKind[] = [K.DISTRIBUTE, K.RECLAIM];

// `alias.column`, always qualified: these statements read the same tables under several aliases.
export const col = (alias: string, column: SQLiteColumn) =>
  sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
export const from = (table: SQLiteTable, alias: string) =>
  sql`${table} as ${sql.identifier(alias)}`;
export const kinds = (values: readonly ChainInstructionKind[]) =>
  sql`(${sql.join(values.map(literal), sql`, `)})`;
export const asInteger = (value: SQL) => sql`cast(${value} as integer)`;
// A sum as decimal integer text; 0 over no rows. SQLite total() never fails on overflow (one huge
// value can never make a day fail) and is exact below 2^53 atomic units (9e9 USDC).
export const atomicTotal = (value: SQL) =>
  sql`cast(cast(total(${value}) as integer) as text)`;
// The block time of transaction alias `alias` falls in the day.
export const inDay = (alias: string, bounds: DayBounds) =>
  sql`${col(alias, chainTxs.blockTime)} >= ${number(bounds.start)} and ${col(alias, chainTxs.blockTime)} < ${number(bounds.end)}`;
// Channel alias `alias` is in scope (left-joined: an unknown channel is never a Gyblos one).
export const inScope = (alias: string, scope: ChainAggregateScope) =>
  scope === CHAIN_AGGREGATE_SCOPES.GYBLOS
    ? sql`${col(alias, chainChannels.gyblos)} = 1`
    : sql`1 = 1`;
export const txJoin = (instruction: string, tx: string) =>
  sql`join ${from(chainTxs, tx)} on ${col(tx, chainTxs.signature)} = ${col(instruction, chainInstructions.signature)}`;
export const channelJoin = (
  instruction: string,
  channel: string,
  left = true,
) =>
  sql`${sql.raw(left ? 'left join' : 'join')} ${from(chainChannels, channel)} on ${col(channel, chainChannels.channel)} = ${col(instruction, chainInstructions.channel)}`;
