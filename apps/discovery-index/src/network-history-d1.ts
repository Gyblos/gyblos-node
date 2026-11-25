import { and, asc, gte, lt } from 'drizzle-orm';

import { UPTIME } from './constants';
import type { DiscoveryDatabase } from './d1-client';
import { indexHeartbeat, networkDays, uptimeSlots } from './schema';
import { mergedBits, slotCount } from './sqlite-expressions';
import {
  dayOfHour,
  hourOf,
  retainedHour,
  slotBit,
  vouchedSlots,
  type NetworkDayRow,
  type NetworkHistoryStorage,
  type UptimeStorage,
} from './uptime';
import { createD1Uptime, integer } from './uptime-d1';

const slotColumns = Object.fromEntries(
  Array.from({ length: UPTIME.slotsPerHour }, (_, bit) => [
    `slot${bit}`,
    slotCount(uptimeSlots.slots, bit),
  ]),
);

async function pruneNetwork(database: DiscoveryDatabase, firstHour: number) {
  await database
    .delete(indexHeartbeat)
    .where(lt(indexHeartbeat.hour, firstHour));
  await database
    .delete(networkDays)
    .where(lt(networkDays.day, dayOfHour(firstHour)));
}

export function createD1UptimeHistory(
  database: DiscoveryDatabase,
): UptimeStorage {
  const uptime = createD1Uptime(database);
  return {
    ...uptime,
    ...createD1NetworkHistory(database),
    async pruneUptime(now) {
      await uptime.pruneUptime(now);
      await pruneNetwork(database, retainedHour(now));
    },
  };
}

function createD1NetworkHistory(
  database: DiscoveryDatabase,
): NetworkHistoryStorage {
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
    async aliveSlots(sinceHour: number, untilHour: number) {
      const rows = await database
        .select({ hour: indexHeartbeat.hour, slots: indexHeartbeat.slots })
        .from(indexHeartbeat)
        .where(
          and(
            gte(indexHeartbeat.hour, sinceHour),
            lt(indexHeartbeat.hour, untilHour),
          ),
        )
        .orderBy(asc(indexHeartbeat.hour));
      return rows.map((row) => ({
        hour: integer(row.hour),
        slots: integer(row.slots),
      }));
    },
    async onlineSlots(sinceHour: number, untilHour: number) {
      const rows = await database
        .select({ hour: uptimeSlots.hour, ...slotColumns })
        .from(uptimeSlots)
        .where(
          and(
            gte(uptimeSlots.hour, sinceHour),
            lt(uptimeSlots.hour, untilHour),
          ),
        )
        .groupBy(uptimeSlots.hour)
        .orderBy(asc(uptimeSlots.hour));
      return rows.map((row) => ({
        hour: integer(row.hour),
        counts: Object.keys(slotColumns).map((name) =>
          integer(Reflect.get(row, name)),
        ),
      }));
    },
    async networkDays(firstDay: number) {
      const rows = await database
        .select()
        .from(networkDays)
        .where(gte(networkDays.day, firstDay))
        .orderBy(asc(networkDays.day));
      return rows.map((row) => ({
        day: integer(row.day),
        nodeSlots: integer(row.nodeSlots),
        peak: integer(row.peak),
        coveredSlots: integer(row.coveredSlots),
      }));
    },
    async saveNetworkDay(row: NetworkDayRow) {
      await database
        .insert(networkDays)
        .values(row)
        .onConflictDoUpdate({
          target: networkDays.day,
          set: {
            nodeSlots: row.nodeSlots,
            peak: row.peak,
            coveredSlots: row.coveredSlots,
          },
        });
    },
  };
}
