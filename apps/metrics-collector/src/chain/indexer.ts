// Owns one scheduled chain read, at most CHAIN_INDEX.maxTransactionsPerRun transactions and one page of
// signatures per phase: (1) the gap of new signatures a previous run could not finish, (2) signatures
// newer than the newest one known (leaving a gap when they do not all fit), (3) history backwards until
// the program's first transaction. Each phase reads newest first, and every batch is stored together
// with the cursor that covers it, so each signature is stored exactly once and a failed run resumes
// where it stopped (re-reading the batch that failed). The accounts of the channels touched (and any left unread) are then read for their state.
import { isNull } from 'drizzle-orm';

import { CHAIN_INDEX } from '../constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from '../d1-client';
import { chainChannels, chainCursor } from '../schema';
import { channelState } from './channel-account';
import { decodeTransaction } from './decode';
import { ChainRpcError, type ChainRpc } from './rpc';
import {
  channelStateUpserts,
  cursorUpsert,
  transactionWrites,
  type ChainCursorState,
} from './writes';

const CURSOR_ID = 1;
export const CHAIN_PHASES = {
  GAP: 'gap',
  FORWARD: 'forward',
  BACKFILL: 'backfill',
  ACCOUNTS: 'accounts',
} as const;
export type ChainPhase = (typeof CHAIN_PHASES)[keyof typeof CHAIN_PHASES];

// A failure with the phase it happened in, for the scheduled run's log.
export class ChainIndexError extends Error {
  constructor(
    readonly phase: ChainPhase,
    readonly cause: unknown,
  ) {
    super(`chain index failed in ${phase}`);
    this.name = 'ChainIndexError';
  }
}

export interface ChainIndexResult {
  // Transactions stored by each phase, and channels whose account was read.
  gap: number;
  forward: number;
  backfill: number;
  channels: number;
  undecodable: number;
  cursor: ChainCursorState;
}

async function readCursor(orm: CollectorDatabase): Promise<ChainCursorState> {
  const [row] = await orm.select().from(chainCursor).limit(1);
  return {
    newest: row?.newestSignature ?? null,
    gapUntil: row?.gapUntil ?? null,
    gapBefore: row?.gapBefore ?? null,
    gapFull: row?.gapFull === 1,
    backfillBefore: row?.backfillBefore ?? null,
    backfillFull: row?.backfillFull === 1,
    backfillDone: row?.backfillDone === 1,
  };
}

interface Run {
  orm: CollectorDatabase;
  rpc: ChainRpc;
  now: number;
  budget: number;
  cursor: ChainCursorState;
  touched: Set<string>;
  undecodable: number;
}

// Stores a page (newest first) up to the budget, in RPC batches, each with the cursor it leaves.
// `after(stored, complete)` is that cursor; complete means the whole page was stored and it was the
// last page of its range.
async function storePage(
  run: Run,
  page: string[],
  after: (stored: string[], complete: boolean) => ChainCursorState,
) {
  const take = page.slice(0, run.budget);
  const lastPage = page.length < CHAIN_INDEX.signaturesPerPage;
  for (
    let start = 0;
    start < take.length;
    start += CHAIN_INDEX.transactionsPerRequest
  ) {
    const batch = take.slice(start, start + CHAIN_INDEX.transactionsPerRequest);
    const decoded = (await run.rpc.transactions(batch)).map(decodeTransaction);
    for (const tx of decoded) {
      run.undecodable += tx.undecodable;
      for (const instruction of tx.instructions)
        run.touched.add(instruction.channel);
    }
    const stored = take.slice(0, start + batch.length);
    const cursor = after(stored, lastPage && stored.length === page.length);
    await run.orm.batch([
      cursorUpsert(run.orm, CURSOR_ID, cursor, run.now),
      ...transactionWrites(run.orm, decoded, run.now),
    ]);
    run.cursor = cursor;
  }
  run.budget -= take.length;
  return take.length;
}
const signaturesOf = (page: { signature: string }[]) =>
  page.map((entry) => entry.signature);

// (1) New signatures strictly between gapUntil and gapBefore.
async function fillGap(run: Run) {
  const { gapUntil, gapBefore } = run.cursor;
  if (!gapUntil || !gapBefore || run.budget <= 0) return 0;
  const page = signaturesOf(
    await run.rpc.signatures({ until: gapUntil, before: gapBefore }),
  );
  if (!page.length) {
    // Known to hold signatures: a lagging RPC that cannot find gapBefore. Retry next run.
    if (!run.cursor.gapFull) throw new ChainRpcError('gap page empty');
    run.cursor = {
      ...run.cursor,
      gapUntil: null,
      gapBefore: null,
      gapFull: false,
    };
    await run.orm.batch([
      cursorUpsert(run.orm, CURSOR_ID, run.cursor, run.now),
    ]);
    return 0;
  }
  return storePage(run, page, (stored, complete) => ({
    ...run.cursor,
    gapUntil: complete ? null : gapUntil,
    gapBefore: complete ? null : stored.at(-1)!,
    gapFull: !complete && page.length === CHAIN_INDEX.signaturesPerPage,
  }));
}

// (2) Signatures newer than the newest known; what does not fit becomes the gap.
async function readForward(run: Run) {
  const known = run.cursor.newest;
  if (!known || run.cursor.gapUntil || run.budget <= 0) return 0;
  const page = signaturesOf(await run.rpc.signatures({ until: known }));
  if (!page.length) return 0;
  const newest = page[0]!;
  return storePage(run, page, (stored, complete) => ({
    ...run.cursor,
    newest,
    gapUntil: complete ? null : known,
    gapBefore: complete ? null : stored.at(-1)!,
    gapFull: !complete && page.length === CHAIN_INDEX.signaturesPerPage,
  }));
}

// (3) History before the oldest signature read; the first run starts from the newest signature.
async function readBackfill(run: Run) {
  if (run.cursor.backfillDone || run.budget <= 0) return 0;
  const before = run.cursor.backfillBefore ?? undefined;
  const page = signaturesOf(await run.rpc.signatures({ before }));
  if (!page.length) {
    // An empty program is not marked done: its first transactions are read when they come.
    if (!run.cursor.newest) return 0;
    // History known to continue (the last page was cut by the budget): a lagging RPC. Retry.
    if (!run.cursor.backfillFull) throw new ChainRpcError('history page empty');
    run.cursor = { ...run.cursor, backfillDone: true };
    await run.orm.batch([
      cursorUpsert(run.orm, CURSOR_ID, run.cursor, run.now),
    ]);
    return 0;
  }
  const newest = run.cursor.newest ?? page[0]!;
  return storePage(run, page, (stored, complete) => ({
    ...run.cursor,
    newest,
    backfillBefore: stored.at(-1)!,
    backfillFull: page.length === CHAIN_INDEX.signaturesPerPage,
    backfillDone: complete,
  }));
}

// Reads the account of every touched channel, and of channels never read, and stores their state.
async function refreshChannels(run: Run) {
  const unread = await run.orm
    .select({ channel: chainChannels.channel })
    .from(chainChannels)
    .where(isNull(chainChannels.accountReadAt))
    .limit(CHAIN_INDEX.accountsPerRequest);
  for (const { channel } of unread) run.touched.add(channel);
  const channels = [...run.touched];
  for (
    let start = 0;
    start < channels.length;
    start += CHAIN_INDEX.accountsPerRequest
  ) {
    const batch = channels.slice(start, start + CHAIN_INDEX.accountsPerRequest);
    const accounts = await run.rpc.accounts(batch);
    const [first, ...rest] = channelStateUpserts(
      run.orm,
      batch.map((channel, index) => ({
        channel,
        state: channelState(accounts[index] ?? null),
      })),
      run.now,
    );
    if (first) await run.orm.batch([first, ...rest]);
  }
  return channels.length;
}

async function phase<T>(name: ChainPhase, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new ChainIndexError(name, error);
  }
}

export async function runChainIndex(
  database: D1Database,
  rpc: ChainRpc,
  now: number,
): Promise<ChainIndexResult> {
  const orm = createD1Orm(database);
  const run: Run = {
    orm,
    rpc,
    now,
    budget: CHAIN_INDEX.maxTransactionsPerRun,
    cursor: await readCursor(orm),
    touched: new Set(),
    undecodable: 0,
  };
  const gap = await phase(CHAIN_PHASES.GAP, () => fillGap(run));
  const forward = await phase(CHAIN_PHASES.FORWARD, () => readForward(run));
  const backfill = await phase(CHAIN_PHASES.BACKFILL, () => readBackfill(run));
  const channels = await phase(CHAIN_PHASES.ACCOUNTS, () =>
    refreshChannels(run),
  );
  return {
    gap,
    forward,
    backfill,
    channels,
    undecodable: run.undecodable,
    cursor: run.cursor,
  };
}
