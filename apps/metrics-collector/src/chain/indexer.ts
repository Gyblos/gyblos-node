// Owns one scheduled chain read. New signatures are read first (oldest first, from the newest one
// already read), then history backwards with the remaining budget: at most
// CHAIN_INDEX.maxTransactionsPerRun transactions per run. Each batch of transactions is stored together with
// the cursor that covers it, so a failed run neither loses nor repeats a transaction; the accounts of
// the channels touched are then read for their deposit, settled amount, payout and status.
import { sql } from 'drizzle-orm';

import { CHAIN_INDEX } from '../constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from '../d1-client';
import { chainChannels, chainCursor } from '../schema';
import { channelState } from './channel-account';
import { decodeTransaction, type ChainTransaction } from './decode';
import type { ChainRpc } from './rpc';
import { channelStateUpserts, cursorUpsert, transactionWrites } from './writes';

const CURSOR_ID = 1;

export interface ChainIndexResult {
  // Transactions stored by this run (forward, then backfill).
  forward: number;
  backfill: number;
  // Channels whose account was read.
  channels: number;
  backfillDone: boolean;
}
interface Cursor {
  newest: string | null;
  backfillBefore: string | null;
  backfillDone: boolean;
}

async function readCursor(orm: CollectorDatabase): Promise<Cursor> {
  const [row] = await orm.select().from(chainCursor).limit(1);
  return {
    newest: row?.newestSignature ?? null,
    backfillBefore: row?.backfillBefore ?? null,
    backfillDone: row?.backfillDone === 1,
  };
}

// Signatures newer than the newest one read, oldest first, at most `budget`.
async function forwardSignatures(
  rpc: ChainRpc,
  newest: string,
  budget: number,
) {
  const newer: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc.signatures({ until: newest, before });
    newer.push(...page.map((entry) => entry.signature));
    const last = page.at(-1);
    if (page.length < CHAIN_INDEX.signaturesPerPage || !last) break;
    before = last.signature;
  }
  return newer.reverse().slice(0, budget);
}

// Reads `signatures` in RPC batches and stores each batch with the cursor it leaves behind.
async function store(
  orm: CollectorDatabase,
  rpc: ChainRpc,
  signatures: string[],
  cursorAfter: (stored: string[]) => Cursor,
  now: number,
  touched: Set<string>,
) {
  for (
    let start = 0;
    start < signatures.length;
    start += CHAIN_INDEX.transactionsPerRequest
  ) {
    const batch = signatures.slice(
      start,
      start + CHAIN_INDEX.transactionsPerRequest,
    );
    const answers = await rpc.transactions(batch);
    const decoded: ChainTransaction[] = [];
    for (const answer of answers)
      if (answer !== null) decoded.push(decodeTransaction(answer));
    for (const tx of decoded)
      for (const instruction of tx.instructions)
        touched.add(instruction.channel);
    const stored = signatures.slice(0, start + batch.length);
    await orm.batch([
      cursorUpsert(orm, CURSOR_ID, cursorAfter(stored), now),
      ...transactionWrites(orm, decoded, now),
    ]);
  }
}

// Reads every touched channel's account and stores its state.
async function refreshChannels(
  orm: CollectorDatabase,
  rpc: ChainRpc,
  channels: string[],
  now: number,
) {
  for (
    let start = 0;
    start < channels.length;
    start += CHAIN_INDEX.accountsPerRequest
  ) {
    const batch = channels.slice(start, start + CHAIN_INDEX.accountsPerRequest);
    const accounts = await rpc.accounts(batch);
    const states = batch.map((channel, index) => ({
      channel,
      state: channelState(accounts[index] ?? null),
    }));
    const [first, ...rest] = channelStateUpserts(orm, states, now);
    if (first) await orm.batch([first, ...rest]);
  }
}

// Channels the index knows whose account was never read (for example after a failed account read).
export const unreadChannels = (orm: CollectorDatabase) =>
  orm
    .select({ channel: chainChannels.channel })
    .from(chainChannels)
    .where(sql`${chainChannels.accountReadAt} is null`);

export async function runChainIndex(
  database: D1Database,
  rpc: ChainRpc,
  now: number,
): Promise<ChainIndexResult> {
  const orm = createD1Orm(database);
  const cursor = await readCursor(orm);
  const touched = new Set<string>();
  let budget: number = CHAIN_INDEX.maxTransactionsPerRun;

  let forward: string[] = [];
  if (cursor.newest) {
    forward = await forwardSignatures(rpc, cursor.newest, budget);
    await store(
      orm,
      rpc,
      forward,
      (stored) => ({ ...cursor, newest: stored.at(-1) ?? cursor.newest }),
      now,
      touched,
    );
    budget -= forward.length;
  }

  // History, newest to oldest from where the backfill stopped (from the top on the first run).
  let backfill: string[] = [];
  let backfillDone = cursor.backfillDone;
  if (!backfillDone && budget > 0) {
    const page = await rpc.signatures({
      before: cursor.backfillBefore ?? undefined,
    });
    backfill = page.map((entry) => entry.signature).slice(0, budget);
    const newest = cursor.newest ?? backfill[0] ?? null;
    const exhausted =
      page.length < CHAIN_INDEX.signaturesPerPage &&
      backfill.length === page.length;
    await store(
      orm,
      rpc,
      backfill,
      (stored) => ({
        newest,
        backfillBefore: stored.at(-1) ?? cursor.backfillBefore,
        backfillDone: exhausted && stored.length === backfill.length,
      }),
      now,
      touched,
    );
    if (!backfill.length)
      await orm.batch([
        cursorUpsert(
          orm,
          CURSOR_ID,
          {
            newest,
            backfillBefore: cursor.backfillBefore,
            backfillDone: exhausted,
          },
          now,
        ),
      ]);
    backfillDone = exhausted;
  }

  // Channels left unread by an earlier failed run are read again too.
  for (const { channel } of await unreadChannels(orm).limit(
    CHAIN_INDEX.accountsPerRequest,
  ))
    touched.add(channel);
  await refreshChannels(orm, rpc, [...touched], now);
  return {
    forward: forward.length,
    backfill: backfill.length,
    channels: touched.size,
    backfillDone,
  };
}
