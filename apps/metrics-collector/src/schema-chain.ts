// Owns the typed chain index tables (#349), matching migrations/0003 exactly (the schema test compares
// them). These declarations perform no I/O.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import type { ChainInstructionKind } from './constants';

export const chainCursor = sqliteTable('collector_chain_cursor', {
  id: integer('id').primaryKey(),
  newestSignature: text('newest_signature'),
  backfillBefore: text('backfill_before'),
  backfillDone: integer('backfill_done').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const chainTxs = sqliteTable(
  'collector_chain_txs',
  {
    signature: text('signature').primaryKey(),
    slot: integer('slot').notNull(),
    blockTime: integer('block_time'),
    failed: integer('failed').notNull(),
    memo: text('memo'),
    indexedAt: integer('indexed_at').notNull(),
  },
  (table) => [index('collector_chain_txs_by_time').on(table.blockTime)],
);

export const chainInstructions = sqliteTable(
  'collector_chain_instructions',
  {
    signature: text('signature').notNull(),
    instructionIndex: integer('instruction_index').notNull(),
    kind: text('kind').$type<ChainInstructionKind>().notNull(),
    channel: text('channel').notNull(),
    payer: text('payer'),
    payee: text('payee'),
    mint: text('mint'),
    amountAtomic: integer('amount_atomic'),
    cumulativeAtomic: integer('cumulative_atomic'),
    recipientsJson: text('recipients_json'),
  },
  (table) => [
    primaryKey({ columns: [table.signature, table.instructionIndex] }),
    index('collector_chain_instructions_by_channel').on(table.channel),
  ],
);

export const chainTokenDeltas = sqliteTable(
  'collector_chain_token_deltas',
  {
    signature: text('signature').notNull(),
    owner: text('owner').notNull(),
    mint: text('mint').notNull(),
    deltaAtomic: integer('delta_atomic').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.signature, table.owner, table.mint] }),
    index('collector_chain_token_deltas_by_owner').on(table.owner),
  ],
);

export const chainChannels = sqliteTable(
  'collector_chain_channels',
  {
    channel: text('channel').primaryKey(),
    payer: text('payer'),
    payee: text('payee'),
    mint: text('mint'),
    authorizedSigner: text('authorized_signer'),
    salt: text('salt'),
    openSlot: integer('open_slot'),
    openedAt: integer('opened_at'),
    gyblos: integer('gyblos').notNull(),
    recipientsJson: text('recipients_json'),
    depositAtomic: integer('deposit_atomic'),
    settledAtomic: integer('settled_atomic'),
    payoutAtomic: integer('payout_atomic'),
    status: text('status'),
    lastSignature: text('last_signature').notNull(),
    lastSlot: integer('last_slot').notNull(),
    accountReadAt: integer('account_read_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('collector_chain_channels_by_payer').on(table.payer)],
);
