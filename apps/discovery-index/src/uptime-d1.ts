// Owns ORM persistence of public uptime; never reads request metadata or opens network connections.
import { and, asc, desc, eq, exists, gte, lt } from 'drizzle-orm';

import { DISCOVERY_INDEX_LIMITS } from './constants';
import type { DiscoveryDatabase } from './d1-client';
import { indexHeartbeat, uptimeNodes, uptimeSlots } from './schema';
import {
  capacityAdmission,
  maximum,
  mergedBits,
  minimum,
  scalarSubquery,
  singleRow,
  slotCount,
  valueField,
} from './sqlite-expressions';
import {
  hourOf,
  retainedHour,
  slotBit,
  UPTIME,
  vouchedSlots,
  type UptimeStorage,
} from './uptime';

// Storage rows are our own, but a corrupted row fails closed (503) instead of being trusted.
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Unexpected discovery storage row.');
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError('Unexpected discovery storage row.');
  return value;
}

function seenQueries(
  database: DiscoveryDatabase,
  nodeId: string,
  now: number,
  maxNodes: number,
) {
  const identity = database
    .select({ nodeId: uptimeNodes.nodeId })
    .from(uptimeNodes)
    .where(eq(uptimeNodes.nodeId, nodeId));
  // CASE avoids a capacity scan for existing identities; both writes run in one native D1 batch.
  const admitted = capacityAdmission(
    exists(identity),
    lt(database.$count(uptimeNodes), maxNodes),
  );
  const first = database
    .insert(uptimeNodes)
    .select(
      database
        .select({
          nodeId: valueField(nodeId, 'nodeId'),
          firstAt: valueField(now, 'firstAt'),
        })
        .from(singleRow())
        .where(admitted),
    )
    .onConflictDoUpdate({
      target: uptimeNodes.nodeId,
      set: { firstAt: minimum(uptimeNodes.firstAt, now) },
    });
  const slot = database
    .insert(uptimeSlots)
    .select(
      database
        .select({
          nodeId: uptimeNodes.nodeId,
          hour: valueField(hourOf(now), 'hour'),
          slots: valueField(slotBit(now), 'slots'),
          firstAt: valueField(now, 'firstAt'),
          lastAt: valueField(now, 'lastAt'),
        })
        .from(uptimeNodes)
        .where(eq(uptimeNodes.nodeId, nodeId)),
    )
    .onConflictDoUpdate({
      target: [uptimeSlots.nodeId, uptimeSlots.hour],
      set: {
        slots: mergedBits(uptimeSlots.slots, slotBit(now)),
        firstAt: minimum(uptimeSlots.firstAt, now),
        lastAt: maximum(uptimeSlots.lastAt, now),
      },
    });
  return [first, slot] as const;
}

function d1Heartbeat(database: DiscoveryDatabase) {
  return {
    async markAlive(now: number) {
      const [first, ...rest] = vouchedSlots(now).map((at) =>
        database
          .insert(indexHeartbeat)
          .values({ hour: hourOf(at), slots: slotBit(at) })
          .onConflictDoUpdate({
            target: indexHeartbeat.hour,
            set: { slots: mergedBits(indexHeartbeat.slots, slotBit(at)) },
          }),
      );
      await database.batch([first!, ...rest]);
    },
    async aliveSlots(sinceHour: number) {
      const rows = await database
        .select({ hour: indexHeartbeat.hour, slots: indexHeartbeat.slots })
        .from(indexHeartbeat)
        .where(gte(indexHeartbeat.hour, sinceHour))
        .orderBy(asc(indexHeartbeat.hour));
      return rows.map((row) => ({
        hour: integer(row.hour),
        slots: integer(row.slots),
      }));
    },
    async onlineSlots(sinceHour: number) {
      const bits = Array.from({ length: UPTIME.slotsPerHour }, (_, bit) =>
        slotCount(uptimeSlots.slots, bit).as(`slot${bit}`),
      );
      const rows = await database
        .select({
          hour: uptimeSlots.hour,
          ...Object.fromEntries(
            bits.map((bit, index) => [`slot${index}`, bit]),
          ),
        })
        .from(uptimeSlots)
        .where(gte(uptimeSlots.hour, sinceHour))
        .groupBy(uptimeSlots.hour)
        .orderBy(asc(uptimeSlots.hour));
      return rows.map((row) => ({
        hour: integer(row.hour),
        counts: bits.map((_, index) =>
          integer(Reflect.get(row, `slot${index}`)),
        ),
      }));
    },
  };
}

export function createD1Uptime(database: DiscoveryDatabase): UptimeStorage {
  return {
    ...d1Heartbeat(database),
    async markSeen(nodeId, now, maxNodes = DISCOVERY_INDEX_LIMITS.maxNodes) {
      const [first, slot] = seenQueries(database, nodeId, now, maxNodes);
      await database.batch([first, slot]);
    },
    async seen(nodeId, sinceHour) {
      const rows = await database
        .select({
          hour: uptimeSlots.hour,
          slots: uptimeSlots.slots,
          firstAt: uptimeSlots.firstAt,
          lastAt: uptimeSlots.lastAt,
        })
        .from(uptimeSlots)
        .where(
          and(eq(uptimeSlots.nodeId, nodeId), gte(uptimeSlots.hour, sinceHour)),
        )
        .orderBy(asc(uptimeSlots.hour));
      return rows.map((row) => ({
        hour: integer(row.hour),
        slots: integer(row.slots),
        firstAt: integer(row.firstAt),
        lastAt: integer(row.lastAt),
      }));
    },
    async sightings(sinceHour, limit) {
      // The NodeId's newest hourly row through the (node_id, hour) primary key: one row per NodeId,
      // never a scan of its history. Its last_at is the latest sighting.
      const latest = database
        .select({ lastAt: uptimeSlots.lastAt })
        .from(uptimeSlots)
        .where(
          and(
            eq(uptimeSlots.nodeId, uptimeNodes.nodeId),
            gte(uptimeSlots.hour, sinceHour),
          ),
        )
        .orderBy(desc(uptimeSlots.hour))
        .limit(1);
      const rows = await database
        .select({
          nodeId: uptimeNodes.nodeId,
          firstAt: uptimeNodes.firstAt,
          lastAt: scalarSubquery(latest).as('lastAt'),
        })
        .from(uptimeNodes)
        .orderBy(asc(uptimeNodes.nodeId))
        .limit(limit);
      return rows.map((row) => ({
        nodeId: text(row.nodeId),
        firstAt: integer(row.firstAt),
        lastAt: row.lastAt === null ? null : integer(row.lastAt),
      }));
    },
    async firstSeen(nodeId) {
      const [row] = await database
        .select({ firstAt: uptimeNodes.firstAt })
        .from(uptimeNodes)
        .where(eq(uptimeNodes.nodeId, nodeId));
      return row ? integer(row.firstAt) : null;
    },
    async pruneUptime(now) {
      await database.batch([
        database
          .delete(uptimeSlots)
          .where(lt(uptimeSlots.hour, retainedHour(now))),
        database
          .delete(indexHeartbeat)
          .where(lt(indexHeartbeat.hour, retainedHour(now))),
      ]);
    },
  };
}
