// Owns one scheduled chain read, spending as few RPC calls as possible (list.ts, follow.ts): the
// program's signature list is counted and its Gyblos opens read, then followed Gyblos channels are
// polled and channel accounts read. A failed list phase never stops the channel phases; the first
// failure is reported after them. A lease keeps two overlapping runs from reading at once, and the
// run stops reading when its call budget is spent.
import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { CHAIN_CURSOR_ID, CHAIN_INDEX } from '../constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from '../d1-client';
import { chainCursor } from '../schema';
import type { ChainEndpoints } from './endpoints';
import { followChannels, refreshChannels } from './follow';
import { fillGap, readBackfill, readForward } from './list';
import type { ChainRun } from './run';
import type { ChainCursorState } from './writes';

export const CHAIN_PHASES = {
  GAP: 'gap',
  FORWARD: 'forward',
  BACKFILL: 'backfill',
  FOLLOW: 'follow',
  ACCOUNTS: 'accounts',
  RELEASE: 'release',
} as const;
export type ChainPhase = (typeof CHAIN_PHASES)[keyof typeof CHAIN_PHASES];

// A failure with the phase it happened in, for the scheduled run's log.
export class ChainIndexError extends Error {
  constructor(
    readonly phase: ChainPhase,
    readonly cause: unknown,
    readonly cleanupFailed = false,
  ) {
    super(`chain index failed in ${phase}`);
    this.name = 'ChainIndexError';
  }
}

export interface ChainIndexResult {
  // Another run holds the lease: nothing was read.
  skipped: boolean;
  // Program signatures counted, transactions read in full, channels polled, channels dropped from
  // listing for flooding it, channel accounts read.
  listed: number;
  read: number;
  followed: number;
  flooded: number;
  channels: number;
  undecodable: number;
  // Work left for later runs: a gap of new signatures, or history not yet read.
  backlog: boolean;
  usage: ReturnType<ChainEndpoints['usage']>;
  cursor: ChainCursorState;
}

async function readCursor(orm: CollectorDatabase): Promise<ChainCursorState> {
  const [row] = await orm.select().from(chainCursor).limit(1);
  return {
    newest: row?.newestSignature ?? null,
    newestSlot: row?.newestSlot ?? null,
    gapUntil: row?.gapUntil ?? null,
    gapBefore: row?.gapBefore ?? null,
    gapUntilSlot: row?.gapUntilSlot ?? null,
    gapFull: row?.gapFull === 1,
    backfillBefore: row?.backfillBefore ?? null,
    backfillFull: row?.backfillFull === 1,
    backfillDone: row?.backfillDone === 1,
  };
}

// Takes the index for CHAIN_INDEX.leaseMs unless another run holds it.
async function acquireLease(orm: CollectorDatabase, now: number) {
  await orm
    .insert(chainCursor)
    .values({
      id: CHAIN_CURSOR_ID,
      gapFull: 0,
      backfillFull: 0,
      backfillDone: 0,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const leaseUntil = now + CHAIN_INDEX.leaseMs;
  const taken = await orm
    .update(chainCursor)
    .set({ leaseUntil })
    .where(
      and(
        eq(chainCursor.id, CHAIN_CURSOR_ID),
        or(isNull(chainCursor.leaseUntil), lt(chainCursor.leaseUntil, now)),
      ),
    )
    .returning({ id: chainCursor.id });
  return taken.length ? leaseUntil : null;
}
const releaseLease = (orm: CollectorDatabase, leaseUntil: number) =>
  orm
    .update(chainCursor)
    .set({ leaseUntil: null })
    .where(
      and(
        eq(chainCursor.id, CHAIN_CURSOR_ID),
        eq(chainCursor.leaseUntil, leaseUntil),
      ),
    );

async function readPhases(run: ChainRun) {
  let failure: ChainIndexError | undefined;
  const attempt = async (name: ChainPhase, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      failure ??= new ChainIndexError(name, error);
    }
  };
  // The list phases run in order and stop at the first failure.
  await attempt(CHAIN_PHASES.GAP, () => fillGap(run));
  if (!failure) await attempt(CHAIN_PHASES.FORWARD, () => readForward(run));
  if (!failure) await attempt(CHAIN_PHASES.BACKFILL, () => readBackfill(run));
  // Channels are followed and accounts read whatever happened to the list.
  await attempt(CHAIN_PHASES.FOLLOW, () => followChannels(run));
  let channels = 0;
  await attempt(CHAIN_PHASES.ACCOUNTS, async () => {
    channels = await refreshChannels(run);
  });
  return { channels, failure };
}

export async function runChainIndex(
  database: D1Database,
  rpc: ChainEndpoints,
  now: number,
): Promise<ChainIndexResult> {
  const orm = createD1Orm(database);
  const leaseUntil = await acquireLease(orm, now);
  const blank: ChainCursorState = {
    newest: null,
    newestSlot: null,
    gapUntil: null,
    gapBefore: null,
    gapUntilSlot: null,
    gapFull: false,
    backfillBefore: null,
    backfillFull: false,
    backfillDone: false,
  };
  const run: ChainRun = {
    orm,
    rpc,
    now,
    lease: leaseUntil,
    leaseLost: false,
    cursor: leaseUntil === null ? await readCursor(orm) : blank,
    touched: new Set(),
    listed: 0,
    read: 0,
    followed: 0,
    flooded: 0,
    undecodable: 0,
  };
  const result = (skipped: boolean, channels: number): ChainIndexResult => ({
    skipped,
    listed: run.listed,
    read: run.read,
    followed: run.followed,
    flooded: run.flooded,
    channels,
    undecodable: run.undecodable,
    backlog: Boolean(run.cursor.gapUntil) || !run.cursor.backfillDone,
    usage: rpc.usage(),
    cursor: run.cursor,
  });
  if (leaseUntil === null) return result(true, 0);
  let failure: unknown;
  let channels = 0;
  try {
    run.cursor = await readCursor(orm);
    const phases = await readPhases(run);
    channels = phases.channels;
    if (phases.failure) throw phases.failure;
  } catch (error) {
    failure = error;
  }
  let releaseError: unknown;
  try {
    await releaseLease(orm, leaseUntil);
  } catch (error) {
    releaseError = error;
  }
  if (failure instanceof ChainIndexError)
    throw new ChainIndexError(
      failure.phase,
      failure.cause,
      releaseError !== undefined,
    );
  if (failure !== undefined) throw failure;
  if (releaseError !== undefined)
    throw new ChainIndexError(CHAIN_PHASES.RELEASE, releaseError);
  return result(false, channels);
}
