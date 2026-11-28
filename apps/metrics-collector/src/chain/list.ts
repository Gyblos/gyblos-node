// Owns the reads of the program's signature list (a thousand per call, each with its error, block
// time and memo), newest first: (1) the gap of new signatures a previous run could not cover, (2)
// signatures newer than the newest known, (3) history backwards until CHAIN_INDEX.historyFloorMs.
// Every listed signature is only counted per day; a transaction is read in full only when it succeeded
// and its memo opens a Gyblos channel. Each stored stretch is written with the cursor that covers it,
// so each signature counts once. A page holding signatures older than the range it was asked for (a
// lagging node that ignored `until`) is refused rather than counted twice.
import { CHANNEL_PROGRAM } from '@gyblos/config/network';

import { CHAIN_INDEX } from '../constants';
import type { ChainTransaction } from './decode';
import { ownedBatch } from './owned';
import { ChainRpcError, type ChainSignature } from './rpc';
import { readTransaction, type ChainRun } from './run';
import {
  cursorUpdate,
  listsGyblosMemo,
  programCounts,
  transactionWrites,
  type ChainCursorState,
} from './writes';

// Counts a list page (newest first) and reads its Gyblos opens, as far as the budget allows; stores
// what it covered with the cursor `after(stored, complete)` leaves. Complete means the whole page was
// covered and it was the last page of its range. A failed read still stores what came before it.
async function storeListPage(
  run: ChainRun,
  page: ChainSignature[],
  lastPage: boolean,
  after: (stored: ChainSignature[], complete: boolean) => ChainCursorState,
) {
  if (run.leaseLost) return 0;
  const read: ChainTransaction[] = [];
  let covered = 0;
  let failure: unknown;
  try {
    for (const entry of page) {
      if (!entry.failed && listsGyblosMemo(entry.memo)) {
        if (run.rpc.remaining() <= 0) break;
        read.push(await readTransaction(run, entry.signature));
      }
      covered += 1;
    }
  } catch (error) {
    failure = error;
  }
  const stored = page.slice(0, covered);
  if (stored.length) {
    const cursor = after(stored, lastPage && stored.length === page.length);
    const owned = await ownedBatch(
      run.orm,
      [
        cursorUpdate(run.orm, cursor, run.now, run.lease),
        ...programCounts(run.orm, stored, run.now, run.lease),
        ...transactionWrites(run.orm, read, run.now, run.lease),
      ],
      run.lease,
    );
    if (!owned) {
      run.leaseLost = true;
    } else {
      run.cursor = cursor;
      run.listed += stored.length;
    }
    if (failure) throw failure;
    return owned ? stored.length : 0;
  }
  if (failure) throw failure;
  return stored.length;
}
// Only a full page covered completely may be followed by an empty range; a page the budget cut is
// known to continue, so an empty answer after it is a lagging RPC.
const fullyCoveredFullPage = (page: unknown[], stored: unknown[]) =>
  page.length === CHAIN_INDEX.signaturesPerPage &&
  stored.length === page.length;
const withinFloor = (entry: ChainSignature) =>
  entry.blockTimeMs === null || entry.blockTimeMs >= CHAIN_INDEX.historyFloorMs;
const listPage = (run: ChainRun, range: { until?: string; before?: string }) =>
  run.rpc.signatures(CHANNEL_PROGRAM, range);
const isLastPage = (page: unknown[]) =>
  page.length < CHAIN_INDEX.signaturesPerPage;
// Every entry must be newer than `untilSlot` (same slot allowed: its order is not known).
function refuseOlder(page: ChainSignature[], untilSlot: number | null) {
  if (untilSlot !== null && page.some((entry) => entry.slot < untilSlot))
    throw new ChainRpcError('page older than its range');
}
async function saveCursor(run: ChainRun, cursor: ChainCursorState) {
  if (run.leaseLost) return;
  const owned = await ownedBatch(
    run.orm,
    [cursorUpdate(run.orm, cursor, run.now, run.lease)],
    run.lease,
  );
  if (!owned) {
    run.leaseLost = true;
    return;
  }
  run.cursor = cursor;
}

// (1) New signatures strictly between gapUntil and gapBefore, several pages per run.
export async function fillGap(run: ChainRun) {
  let total = 0;
  for (let pages = 0; pages < CHAIN_INDEX.maxListPagesPerRun; pages += 1) {
    if (run.leaseLost) break;
    const { gapUntil, gapBefore, gapUntilSlot } = run.cursor;
    if (!gapUntil || !gapBefore || run.rpc.remaining() <= 0) break;
    const page = await listPage(run, { until: gapUntil, before: gapBefore });
    if (!page.length) {
      // Known to hold signatures: a lagging RPC that cannot find gapBefore. Retry next run.
      if (!run.cursor.gapFull) throw new ChainRpcError('gap page empty');
      // After a full page the gap may be empty or not: it is empty only if the signature right before
      // gapBefore is gapUntil (one more call, only in this case). Otherwise retry next run.
      if (run.rpc.remaining() <= 0) break;
      const [previous] = await listPage(run, { before: gapBefore });
      if (previous?.signature !== gapUntil)
        throw new ChainRpcError('gap page empty');
      await saveCursor(run, {
        ...run.cursor,
        gapUntil: null,
        gapBefore: null,
        gapUntilSlot: null,
        gapFull: false,
      });
      break;
    }
    refuseOlder(page, gapUntilSlot);
    const counted = page.filter(withinFloor);
    if (!counted.length) {
      const complete = isLastPage(page);
      await saveCursor(run, {
        ...run.cursor,
        gapUntil: complete ? null : gapUntil,
        gapBefore: complete ? null : page.at(-1)!.signature,
        gapUntilSlot: complete ? null : gapUntilSlot,
        gapFull: !complete,
      });
      continue;
    }
    total += await storeListPage(
      run,
      counted,
      isLastPage(page),
      (stored, complete) => ({
        ...run.cursor,
        gapUntil: complete ? null : gapUntil,
        gapBefore: complete ? null : stored.at(-1)!.signature,
        gapUntilSlot: complete ? null : gapUntilSlot,
        gapFull: !complete && fullyCoveredFullPage(page, stored),
      }),
    );
  }
  return total;
}

// (2) Signatures newer than the newest known; what does not fit becomes the gap.
export async function readForward(run: ChainRun) {
  const { newest: known, newestSlot } = run.cursor;
  if (!known || run.cursor.gapUntil || run.rpc.remaining() <= 0) return 0;
  const page = await listPage(run, { until: known });
  if (!page.length) return 0;
  refuseOlder(page, newestSlot);
  const top = page[0]!;
  const counted = page.filter(withinFloor);
  if (!counted.length) {
    await saveCursor(run, {
      ...run.cursor,
      newest: top.signature,
      newestSlot: top.slot,
    });
    return 0;
  }
  return storeListPage(run, counted, isLastPage(page), (stored, complete) => ({
    ...run.cursor,
    newest: top.signature,
    newestSlot: top.slot,
    gapUntil: complete ? null : known,
    gapUntilSlot: complete ? null : newestSlot,
    gapBefore: complete ? null : stored.at(-1)!.signature,
    gapFull: !complete && fullyCoveredFullPage(page, stored),
  }));
}

// (3) History before the oldest signature counted, down to the history floor; the first run starts
// from the newest signature. Several pages per run while the budget allows.
export async function readBackfill(run: ChainRun) {
  let total = 0;
  for (let pages = 0; pages < CHAIN_INDEX.maxListPagesPerRun; pages += 1) {
    if (run.leaseLost) break;
    if (run.cursor.backfillDone || run.rpc.remaining() <= 0) break;
    const stored = await backfillPage(run);
    total += stored;
    if (!stored) break;
  }
  return total;
}
async function backfillPage(run: ChainRun) {
  const before = run.cursor.backfillBefore ?? undefined;
  const listed = await listPage(run, { before });
  if (!listed.length) {
    // An empty program is not marked done: its first transactions are read when they come.
    if (!run.cursor.newest) return 0;
    // History known to continue (the last page was cut by the budget): a lagging RPC. Retry.
    if (!run.cursor.backfillFull) throw new ChainRpcError('history page empty');
  }
  // Signatures older than the floor are not read: the page ends the history there.
  const page = listed.filter(withinFloor);
  const reachedFloor = page.length < listed.length;
  const top = listed[0];
  const start = {
    newest: run.cursor.newest ?? top?.signature ?? null,
    newestSlot: run.cursor.newest ? run.cursor.newestSlot : (top?.slot ?? null),
  };
  if (!page.length) {
    await saveCursor(run, { ...run.cursor, ...start, backfillDone: true });
    return 0;
  }
  return storeListPage(
    run,
    page,
    reachedFloor || isLastPage(listed),
    (stored, complete) => ({
      ...run.cursor,
      ...start,
      backfillBefore: stored.at(-1)!.signature,
      backfillFull: !reachedFloor && fullyCoveredFullPage(listed, stored),
      backfillDone: complete,
    }),
  );
}
