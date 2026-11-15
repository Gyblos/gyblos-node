// Owns ORM persistence of public uptime; never reads request metadata or opens network connections.
import { and, asc, eq, exists, gte, lt, sql } from 'drizzle-orm';

import { DISCOVERY_INDEX_LIMITS } from './constants';
import type { DiscoveryDatabase } from './d1-client';
import { uptimeNodes, uptimeSlots } from './schema';
import { hourOf, retainedHour, slotBit, type UptimeStorage } from './uptime';

function integer(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
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
  const admitted = sql<boolean>`case when ${exists(identity)} then 1 else ${lt(database.$count(uptimeNodes), maxNodes)} end`;
  const first = database
    .insert(uptimeNodes)
    .select(
      database
        .select({
          nodeId: sql<string>`${nodeId}`.as('nodeId'),
          firstAt: sql<number>`${now}`.as('firstAt'),
        })
        .from(sql`(values (1))`)
        .where(admitted),
    )
    .onConflictDoUpdate({
      target: uptimeNodes.nodeId,
      set: { firstAt: sql<number>`min(${uptimeNodes.firstAt}, ${now})` },
    });
  const slot = database
    .insert(uptimeSlots)
    .select(
      database
        .select({
          nodeId: uptimeNodes.nodeId,
          hour: sql<number>`${hourOf(now)}`.as('hour'),
          slots: sql<number>`${slotBit(now)}`.as('slots'),
          firstAt: sql<number>`${now}`.as('firstAt'),
          lastAt: sql<number>`${now}`.as('lastAt'),
        })
        .from(uptimeNodes)
        .where(eq(uptimeNodes.nodeId, nodeId)),
    )
    .onConflictDoUpdate({
      target: [uptimeSlots.nodeId, uptimeSlots.hour],
      set: {
        slots: sql<number>`${uptimeSlots.slots} | ${slotBit(now)}`,
        firstAt: sql<number>`min(${uptimeSlots.firstAt}, ${now})`,
        lastAt: sql<number>`max(${uptimeSlots.lastAt}, ${now})`,
      },
    });
  return [first, slot] as const;
}

export function createD1Uptime(database: DiscoveryDatabase): UptimeStorage {
  return {
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
    async firstSeen(nodeId) {
      const [row] = await database
        .select({ firstAt: uptimeNodes.firstAt })
        .from(uptimeNodes)
        .where(eq(uptimeNodes.nodeId, nodeId));
      return row ? integer(row.firstAt) : null;
    },
    async pruneUptime(now) {
      await database
        .delete(uptimeSlots)
        .where(lt(uptimeSlots.hour, retainedHour(now)));
    },
  };
}
