// Owns the typed SQLite schema used by discovery's ORM. Wrangler migrations own physical DDL.
// Table declarations contain no client, I/O or mutable runtime state.
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import { REGISTRATION_STATUS } from './constants';

export const nodes = sqliteTable('discovery_nodes', {
  nodeId: text('node_id').primaryKey(),
  lastSequence: integer('last_sequence').notNull(),
  lastSignature: text('last_signature').notNull(),
  retainUntil: integer('retain_until').notNull(),
  publishWindow: integer('publish_window').notNull().default(0),
  publishCount: integer('publish_count').notNull().default(0),
});
export const catalogs = sqliteTable('discovery_catalogs', {
  nodeId: text('node_id').primaryKey(),
  owner: text('owner').notNull(),
  sequence: integer('sequence').notNull(),
  issuedAt: integer('issued_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  digest: text('digest').notNull(),
  json: text('signed_json').notNull(),
});
export const models = sqliteTable(
  'discovery_catalog_models',
  {
    nodeId: text('node_id').notNull(),
    modelId: text('model_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.nodeId, table.modelId] })],
);
export const presence = sqliteTable('discovery_presence', {
  nodeId: text('node_id').primaryKey(),
  sequence: integer('sequence').notNull(),
  issuedAt: integer('issued_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  digest: text('catalog_digest').notNull(),
  json: text('signed_json').notNull(),
});
export const withdrawals = sqliteTable('discovery_withdrawals', {
  nodeId: text('node_id').primaryKey(),
  sequence: integer('sequence').notNull(),
  issuedAt: integer('issued_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  digest: text('catalog_digest').notNull(),
  json: text('signed_json').notNull(),
});

export const invites = sqliteTable('discovery_invites', {
  inviteHash: text('invite_hash').primaryKey(),
  contact: text('contact').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  nodeId: text('node_id'),
});
export const registrations = sqliteTable('discovery_registrations', {
  nodeId: text('node_id').primaryKey(),
  owner: text('owner').notNull(),
  asset: text('asset').notNull(),
  status: text('status', {
    enum: [REGISTRATION_STATUS.ACTIVE, REGISTRATION_STATUS.REVOKED],
  }).notNull(),
  inviteHash: text('invite_hash').notNull(),
  country: text('country'),
  registeredAt: integer('registered_at').notNull(),
});
