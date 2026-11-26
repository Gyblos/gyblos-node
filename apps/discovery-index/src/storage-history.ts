import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  max,
  ne,
  notExists,
  or,
  type SQL,
} from 'drizzle-orm';

import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';

import {
  OFFER_HISTORY,
  PERIOD_END_REASONS,
  type PeriodEndReason,
} from './constants';
import type { DiscoveryDatabase } from './d1-client';
import type { HistoryPeriod, HistoryQuery } from './offer-history';
import { catalogPeriods, nodes, offerItems } from './schema';
import {
  atLeast,
  atMost,
  jsonOfferRows,
  jsonTextValues,
  maximum,
  nullField,
  valueField,
  whenElse,
} from './sqlite-expressions';
import type { StoredEntry } from './storage';
import { integer, text } from './uptime-d1';

const END_REASONS: ReadonlySet<string> = new Set(
  Object.values(PERIOD_END_REASONS),
);

function closeOpen(
  database: DiscoveryDatabase,
  entry: StoredEntry,
  won: SQL,
  reason: PeriodEndReason,
  unless?: SQL,
) {
  const now = entry.admission.now;
  const lapsed = lte(catalogPeriods.expiresAt, now);
  return database
    .update(catalogPeriods)
    .set({
      endedAt: whenElse<number>(
        lapsed,
        catalogPeriods.expiresAt,
        maximum(catalogPeriods.lastPublishedAt, now),
      ),
      endReason: whenElse<string>(lapsed, PERIOD_END_REASONS.EXPIRED, reason),
    })
    .where(
      and(
        eq(catalogPeriods.nodeId, entry.nodeId),
        isNull(catalogPeriods.endedAt),
        lt(catalogPeriods.lastSequence, entry.sequence),
        won,
        unless,
      ),
    );
}

function itemsQuery(
  database: DiscoveryDatabase,
  hash: string,
  json: string,
  won: SQL,
) {
  const known = database
    .select({ hash: offerItems.contentHash })
    .from(offerItems)
    .where(eq(offerItems.contentHash, hash));
  return database
    .insert(offerItems)
    .select(jsonOfferRows(hash, json, and(won, notExists(known))!))
    .onConflictDoNothing();
}

function openQuery(
  database: DiscoveryDatabase,
  entry: StoredEntry,
  hash: string,
  won: SQL,
  open: SQL,
) {
  const now = entry.admission.now;
  const start = atMost(
    atLeast(
      now,
      database
        .select({ end: max(catalogPeriods.endedAt) })
        .from(catalogPeriods)
        .where(eq(catalogPeriods.nodeId, entry.nodeId)),
    ),
    entry.expiresAt,
  );
  return database.insert(catalogPeriods).select(
    database
      .select({
        nodeId: nodes.nodeId,
        firstSequence: valueField(entry.sequence, 'firstSequence'),
        contentHash: valueField(hash, 'contentHash'),
        owner: valueField(entry.owner, 'owner'),
        startedAt: start.as('startedAt'),
        lastSequence: valueField(entry.sequence, 'lastSequence'),
        lastPublishedAt: start.as('lastPublishedAt'),
        expiresAt: valueField(entry.expiresAt, 'expiresAt'),
        endedAt: nullField('endedAt'),
        endReason: nullField('endReason'),
      })
      .from(nodes)
      .where(
        and(
          eq(nodes.nodeId, entry.nodeId),
          won,
          notExists(
            database
              .select({ nodeId: catalogPeriods.nodeId })
              .from(catalogPeriods)
              .where(open),
          ),
        ),
      ),
  );
}

export function historyQueries(
  database: DiscoveryDatabase,
  entry: StoredEntry,
  won: SQL,
) {
  if (entry.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL)
    return [closeOpen(database, entry, won, PERIOD_END_REASONS.WITHDRAWN)];
  const content = entry.offers;
  if (entry.kind !== PUBLIC_RECORD_KINDS.CATALOG || !content) return [];
  const now = entry.admission.now;
  const open = and(
    eq(catalogPeriods.nodeId, entry.nodeId),
    isNull(catalogPeriods.endedAt),
  )!;
  return [
    itemsQuery(database, content.hash, content.json, won),
    closeOpen(
      database,
      entry,
      won,
      PERIOD_END_REASONS.REPLACED,
      or(
        ne(catalogPeriods.contentHash, content.hash),
        ne(catalogPeriods.owner, entry.owner),
        lte(catalogPeriods.expiresAt, now),
      ),
    ),
    database
      .update(catalogPeriods)
      .set({
        lastSequence: entry.sequence,
        lastPublishedAt: atMost(
          maximum(catalogPeriods.lastPublishedAt, now),
          entry.expiresAt,
        ),
        expiresAt: entry.expiresAt,
      })
      .where(and(open, lt(catalogPeriods.lastSequence, entry.sequence), won)),
    openQuery(database, entry, content.hash, won, open),
  ];
}

const endedBy = (time: number) =>
  or(
    lte(catalogPeriods.endedAt, time),
    and(isNull(catalogPeriods.endedAt), lte(catalogPeriods.expiresAt, time)),
  )!;

export function historyPruneQueries(database: DiscoveryDatabase, now: number) {
  const cutoff = now - OFFER_HISTORY.retentionDays * OFFER_HISTORY.dayMs;
  const kept = database
    .select({ hash: catalogPeriods.contentHash })
    .from(catalogPeriods)
    .where(
      and(
        eq(catalogPeriods.contentHash, offerItems.contentHash),
        or(
          gt(catalogPeriods.endedAt, cutoff),
          and(
            isNull(catalogPeriods.endedAt),
            gt(catalogPeriods.expiresAt, cutoff),
          ),
        ),
      ),
    );
  return [
    database
      .delete(offerItems)
      .where(
        and(
          inArray(
            offerItems.contentHash,
            database
              .select({ hash: catalogPeriods.contentHash })
              .from(catalogPeriods)
              .where(endedBy(cutoff)),
          ),
          notExists(kept),
        ),
      ),
    database.delete(catalogPeriods).where(endedBy(cutoff)),
  ] as const;
}

function periodsQuery(database: DiscoveryDatabase, query: HistoryQuery) {
  const recent = or(
    gt(catalogPeriods.endedAt, query.since),
    and(
      isNull(catalogPeriods.endedAt),
      gt(catalogPeriods.expiresAt, query.since),
    ),
  );
  const listing =
    query.model === null
      ? undefined
      : exists(
          database
            .select({ hash: offerItems.contentHash })
            .from(offerItems)
            .where(
              and(
                eq(offerItems.modelId, query.model),
                eq(offerItems.contentHash, catalogPeriods.contentHash),
              ),
            ),
        );
  return database
    .select()
    .from(catalogPeriods)
    .where(
      and(
        query.nodeId === null
          ? undefined
          : eq(catalogPeriods.nodeId, query.nodeId),
        recent,
        listing,
      ),
    )
    .orderBy(
      desc(catalogPeriods.startedAt),
      desc(catalogPeriods.firstSequence),
      asc(catalogPeriods.nodeId),
    )
    .limit(query.limit);
}

const endReason = (value: unknown) => {
  if (value === null) return null;
  const reason = text(value);
  if (!END_REASONS.has(reason)) throw new Error('unknown period end reason');
  return reason as PeriodEndReason;
};

export async function readOfferHistory(
  database: DiscoveryDatabase,
  query: HistoryQuery,
): Promise<HistoryPeriod[]> {
  const periods = await periodsQuery(database, query);
  if (!periods.length) return [];
  const hashes = [...new Set(periods.map((period) => period.contentHash))];
  const items = await database
    .select()
    .from(offerItems)
    .where(
      and(
        inArray(offerItems.contentHash, jsonTextValues(hashes)),
        query.model === null ? undefined : eq(offerItems.modelId, query.model),
      ),
    )
    .orderBy(asc(offerItems.contentHash), asc(offerItems.position));
  const offers = new Map<string, HistoryPeriod['offers']>();
  for (const item of items)
    offers.set(item.contentHash, [
      ...(offers.get(item.contentHash) ?? []),
      {
        modelId: text(item.modelId),
        variant: item.variant === null ? null : text(item.variant),
        quantization:
          item.quantization === null ? null : text(item.quantization),
        contextTokens: integer(item.contextTokens),
        reasoning: JSON.parse(text(item.reasoning)) as string[],
        pricing: {
          inputAtomicPerMtok: text(item.inputAtomic),
          outputAtomicPerMtok: text(item.outputAtomic),
          unit: text(item.unit),
          network: text(item.network),
          asset: text(item.asset),
        },
      },
    ]);
  return periods.map((period) => ({
    nodeId: text(period.nodeId),
    owner: text(period.owner),
    firstSequence: integer(period.firstSequence),
    lastSequence: integer(period.lastSequence),
    startedAt: integer(period.startedAt),
    lastPublishedAt: integer(period.lastPublishedAt),
    expiresAt: integer(period.expiresAt),
    endedAt: period.endedAt === null ? null : integer(period.endedAt),
    endReason: endReason(period.endReason),
    offers: offers.get(period.contentHash) ?? [],
  }));
}
