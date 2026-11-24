// Owns discovery's typed tables, keys, indexes and checks. Historical D1 migrations retain
// physical WITHOUT ROWID layout; these declarations perform no client initialization or I/O.
import {
  between,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import {
  DISCOVERY_LISTING_INDEXES,
  GITHUB_CLAIM_STATES,
  REGISTRATION,
  REGISTRATION_STATUS,
  SELLER_PROFILE,
  UPTIME,
} from './constants';
import { nullableTextLength, textLength } from './sqlite-expressions';

const literalCheck = (name: string, value: SQL) =>
  check(name, value.inlineParams());

const nodeIdCharacters =
  PUBLIC_RECORD_LIMITS.publicKeyBytes *
  PUBLIC_RECORD_LIMITS.hexCharactersPerByte;

export const nodes = sqliteTable(
  'discovery_nodes',
  {
    nodeId: text('node_id').primaryKey(),
    lastSequence: integer('last_sequence').notNull(),
    lastSignature: text('last_signature').notNull(),
    retainUntil: integer('retain_until').notNull(),
    publishWindow: integer('publish_window').notNull().default(0),
    publishCount: integer('publish_count').notNull().default(0),
  },
  (table) => [
    index('discovery_nodes_by_retain').on(table.retainUntil),
    literalCheck(
      'discovery_nodes_node_id',
      eq(textLength(table.nodeId), nodeIdCharacters),
    ),
    literalCheck('discovery_nodes_sequence', gte(table.lastSequence, 1)),
  ],
);
export const catalogs = sqliteTable(
  'discovery_catalogs',
  {
    nodeId: text('node_id').primaryKey(),
    owner: text('owner').notNull(),
    sequence: integer('sequence').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    digest: text('digest').notNull(),
    json: text('signed_json').notNull(),
  },
  (table) => [
    index('discovery_catalogs_by_expiry').on(table.expiresAt),
    index(DISCOVERY_LISTING_INDEXES.CATALOG).on(
      table.nodeId,
      table.digest,
      table.issuedAt,
      table.expiresAt,
    ),
  ],
);
export const models = sqliteTable(
  'discovery_catalog_models',
  {
    nodeId: text('node_id').notNull(),
    modelId: text('model_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.modelId] }),
    index('discovery_catalog_models_by_model').on(table.modelId, table.nodeId),
  ],
);
export const presence = sqliteTable(
  'discovery_presence',
  {
    nodeId: text('node_id').primaryKey(),
    sequence: integer('sequence').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    digest: text('catalog_digest').notNull(),
    json: text('signed_json').notNull(),
    releaseVersion: text('release_version'),
    versionSequence: integer('version_sequence'),
  },
  (table) => [
    index('discovery_presence_by_expiry').on(table.expiresAt),
    index(DISCOVERY_LISTING_INDEXES.PRESENCE).on(
      table.nodeId,
      table.digest,
      table.issuedAt,
      table.expiresAt,
    ),
  ],
);
export const withdrawals = sqliteTable(
  'discovery_withdrawals',
  {
    nodeId: text('node_id').primaryKey(),
    sequence: integer('sequence').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    digest: text('catalog_digest').notNull(),
    json: text('signed_json').notNull(),
  },
  (table) => [
    index('discovery_withdrawals_by_expiry').on(table.expiresAt),
    index(DISCOVERY_LISTING_INDEXES.WITHDRAWAL).on(table.nodeId, table.digest),
  ],
);

export const offerItems = sqliteTable(
  'discovery_offer_items',
  {
    contentHash: text('content_hash').notNull(),
    position: integer('position').notNull(),
    modelId: text('model_id').notNull(),
    variant: text('variant'),
    quantization: text('quantization'),
    contextTokens: integer('context_tokens').notNull(),
    reasoning: text('reasoning').notNull(),
    inputAtomic: text('input_atomic').notNull(),
    outputAtomic: text('output_atomic').notNull(),
    unit: text('unit').notNull(),
    network: text('network').notNull(),
    asset: text('asset').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.contentHash, table.position] }),
    index('discovery_offer_items_by_model').on(
      table.modelId,
      table.contentHash,
    ),
  ],
);
export const catalogPeriods = sqliteTable(
  'discovery_catalog_periods',
  {
    nodeId: text('node_id').notNull(),
    firstSequence: integer('first_sequence').notNull(),
    contentHash: text('content_hash').notNull(),
    owner: text('owner').notNull(),
    startedAt: integer('started_at').notNull(),
    lastSequence: integer('last_sequence').notNull(),
    lastPublishedAt: integer('last_published_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    endedAt: integer('ended_at'),
    endReason: text('end_reason'),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.firstSequence] }),
    index('discovery_catalog_periods_open').on(table.nodeId, table.endedAt),
    index('discovery_catalog_periods_by_content').on(table.contentHash),
    index('discovery_catalog_periods_by_start').on(table.startedAt),
  ],
);

export const invites = sqliteTable(
  'discovery_invites',
  {
    inviteHash: text('invite_hash').primaryKey(),
    contact: text('contact').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    nodeId: text('node_id'),
  },
  (table) => [
    literalCheck(
      'discovery_invites_hash',
      eq(textLength(table.inviteHash), REGISTRATION.inviteHashCharacters),
    ),
    literalCheck(
      'discovery_invites_contact',
      between(textLength(table.contact), 1, REGISTRATION.maxContactCharacters),
    ),
    literalCheck(
      'discovery_invites_node_id',
      nullableTextLength(table.nodeId, nodeIdCharacters),
    ),
  ],
);
export const registrations = sqliteTable(
  'discovery_registrations',
  {
    nodeId: text('node_id').primaryKey(),
    owner: text('owner').notNull(),
    asset: text('asset').notNull(),
    status: text('status', {
      enum: [REGISTRATION_STATUS.ACTIVE, REGISTRATION_STATUS.REVOKED],
    }).notNull(),
    inviteHash: text('invite_hash').notNull(),
    country: text('country'),
    registeredAt: integer('registered_at').notNull(),
  },
  (table) => [
    literalCheck(
      'discovery_registrations_node_id',
      eq(textLength(table.nodeId), nodeIdCharacters),
    ),
    literalCheck(
      'discovery_registrations_status',
      inArray(table.status, Object.values(REGISTRATION_STATUS)),
    ),
    literalCheck(
      'discovery_registrations_country',
      nullableTextLength(table.country, REGISTRATION.countryCharacters),
    ),
  ],
);

export const uptimeNodes = sqliteTable(
  'discovery_uptime_nodes',
  {
    nodeId: text('node_id').primaryKey(),
    firstAt: integer('first_at').notNull(),
  },
  (table) => [
    literalCheck(
      'discovery_uptime_nodes_node_id',
      eq(textLength(table.nodeId), nodeIdCharacters),
    ),
  ],
);
export const uptimeSlots = sqliteTable(
  'discovery_uptime',
  {
    nodeId: text('node_id').notNull(),
    hour: integer('hour').notNull(),
    slots: integer('slots').notNull(),
    firstAt: integer('first_at').notNull(),
    lastAt: integer('last_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.hour] }),
    index('discovery_uptime_by_hour').on(table.hour),
    literalCheck(
      'discovery_uptime_node_id',
      eq(textLength(table.nodeId), nodeIdCharacters),
    ),
    literalCheck(
      'discovery_uptime_slots',
      between(table.slots, 1, 2 ** UPTIME.slotsPerHour - 1),
    ),
  ],
);

export const githubClaims = sqliteTable(
  'discovery_github_claims',
  {
    nodeId: text('node_id').primaryKey(),
    account: text('account'),
    gist: text('gist'),
    issuedAt: integer('issued_at').notNull(),
    state: text('state', {
      enum: [
        GITHUB_CLAIM_STATES.PENDING,
        GITHUB_CLAIM_STATES.VERIFIED,
        GITHUB_CLAIM_STATES.LOST,
      ],
    }),
    reason: text('reason'),
    checkedAt: integer('checked_at'),
    verdictAt: integer('verdict_at'),
    verifiedAt: integer('verified_at'),
    lastFetchAt: integer('last_fetch_at'),
    nextCheckAt: integer('next_check_at'),
    signature: text('signature'),
  },
  (table) => [
    index('discovery_github_claims_by_next_check').on(table.nextCheckAt),
    literalCheck(
      'discovery_github_claims_node_id',
      eq(textLength(table.nodeId), nodeIdCharacters),
    ),
    literalCheck(
      'discovery_github_claims_state',
      sql`${or(
        isNull(table.state),
        inArray(table.state, Object.values(GITHUB_CLAIM_STATES)),
      )}`,
    ),
  ],
);
export const sellerProfiles = sqliteTable(
  'discovery_seller_profiles',
  {
    nodeId: text('node_id').primaryKey(),
    name: text('name'),
    issuedAt: integer('issued_at').notNull(),
    signature: text('signature'),
    held: integer('held').notNull().default(SELLER_PROFILE.open),
  },
  (table) => [
    literalCheck(
      'discovery_seller_profiles_node_id',
      eq(textLength(table.nodeId), nodeIdCharacters),
    ),
    literalCheck(
      'discovery_seller_profiles_tombstone',
      sql`(${isNull(table.name)}) = (${isNull(table.signature)})`,
    ),
    literalCheck(
      'discovery_seller_profiles_held',
      inArray(table.held, [SELLER_PROFILE.open, SELLER_PROFILE.held]),
    ),
    literalCheck(
      'discovery_seller_profiles_held_empty',
      sql`${or(eq(table.held, SELLER_PROFILE.open), isNull(table.name))}`,
    ),
  ],
);
