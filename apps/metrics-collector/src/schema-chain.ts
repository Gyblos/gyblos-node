// Owns the typed chain index tables (#349) and their daily aggregates, matching migrations/0003,
// 0004 and 0006 exactly (the schema test compares them). These declarations perform no I/O.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import type { ChainAggregateScope, ChainInstructionKind } from './constants';

export const chainCursor = sqliteTable('collector_chain_cursor', {
  id: integer('id').primaryKey(),
  newestSignature: text('newest_signature'),
  gapUntil: text('gap_until'),
  gapBefore: text('gap_before'),
  gapFull: integer('gap_full').notNull(),
  backfillBefore: text('backfill_before'),
  backfillFull: integer('backfill_full').notNull(),
  backfillDone: integer('backfill_done').notNull(),
  updatedAt: integer('updated_at').notNull(),
  newestSlot: integer('newest_slot'),
  gapUntilSlot: integer('gap_until_slot'),
  leaseUntil: integer('lease_until'),
});

export const chainTxs = sqliteTable(
  'collector_chain_txs',
  {
    signature: text('signature').primaryKey(),
    slot: integer('slot').notNull(),
    blockTime: integer('block_time'),
    failed: integer('failed').notNull(),
    undecodable: integer('undecodable').notNull(),
    memo: text('memo'),
    indexedAt: integer('indexed_at').notNull(),
  },
  (table) => [
    index('collector_chain_txs_by_time').on(table.blockTime),
    index('collector_chain_txs_by_indexed').on(table.indexedAt),
  ],
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
    amountAtomic: text('amount_atomic'),
    cumulativeAtomic: text('cumulative_atomic'),
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
    deltaAtomic: text('delta_atomic').notNull(),
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
    depositAtomic: text('deposit_atomic'),
    settledAtomic: text('settled_atomic'),
    payoutAtomic: text('payout_atomic'),
    status: text('status'),
    lastSignature: text('last_signature').notNull(),
    lastSlot: integer('last_slot').notNull(),
    accountReadAt: integer('account_read_at'),
    updatedAt: integer('updated_at').notNull(),
    following: integer('following').notNull().default(0),
    followUntil: text('follow_until'),
    followedAt: integer('followed_at'),
  },
  (table) => [
    index('collector_chain_channels_by_payer').on(table.payer),
    index('collector_chain_channels_by_follow').on(
      table.following,
      table.followedAt,
    ),
  ],
);

export const chainProgramDaily = sqliteTable('collector_chain_program_daily', {
  day: text('day').primaryKey(),
  transactions: integer('transactions').notNull(),
  failed: integer('failed').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const aggChainState = sqliteTable('collector_agg_chain_state', {
  id: integer('id').primaryKey(),
  scannedAt: integer('scanned_at').notNull(),
  formulaVersion: integer('formula_version').notNull(),
});

export const aggChainDirtyDays = sqliteTable('collector_agg_chain_dirty_days', {
  day: text('day').primaryKey(),
});

export const aggChainDaily = sqliteTable(
  'collector_agg_chain_daily',
  {
    day: text('day').notNull(),
    scope: text('scope').$type<ChainAggregateScope>().notNull(),
    transactions: integer('transactions').notNull(),
    failed: integer('failed').notNull(),
    undecodable: integer('undecodable').notNull(),
    opens: integer('opens').notNull(),
    settles: integer('settles').notNull(),
    topUps: integer('top_ups').notNull(),
    settleAndSeals: integer('settle_and_seals').notNull(),
    requestCloses: integer('request_closes').notNull(),
    seals: integer('seals').notNull(),
    distributes: integer('distributes').notNull(),
    reclaims: integer('reclaims').notNull(),
    channels: integer('channels').notNull(),
    payers: integer('payers').notNull(),
    payees: integer('payees').notNull(),
    depositedAtomic: text('deposited_atomic').notNull(),
    settledAtomic: text('settled_atomic').notNull(),
    gyblosFeesAtomic: text('gyblos_fees_atomic').notNull(),
    programTreasuryAtomic: text('program_treasury_atomic').notNull(),
    refundedAtomic: text('refunded_atomic').notNull(),
    paidOutAtomic: text('paid_out_atomic').notNull(),
    formulaVersion: integer('formula_version').notNull(),
    aggregatedAt: integer('aggregated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.scope] })],
);
