// One private index reserves buyer slots before deposit submission; each child's journal owns its terms.
// Interrupted initial publication is repaired only from its exact pristine prepared state.
import { opendir } from 'node:fs/promises';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  batchSellerBuyerPaths,
  type BatchSellerPaths,
} from '@gyblos/config/home';
import { canonicalJson } from '@gyblos/protocol';
import {
  controlArray,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  PaymentSessionError,
  SESSION_CODES,
  sessionFail,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  ensurePrivatePaymentPaths,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { termsFor } from './batch-session-checks';
import { initialRecord } from './batch-session-common';
import { withBatchState } from './batch-session-io';
import {
  inspectBatchSession,
  readBatchRecord,
  storedBatchSession,
} from './batch-session-state';
import { BATCH_SELLER_REGISTRY } from './constants';

export interface SellerRegistryRow {
  buyerNodeId: string;
  legacy: boolean;
  prepared: PaymentSessionTerms | null;
}
interface Record {
  version: typeof BATCH_SELLER_REGISTRY.version;
  entries: SellerRegistryRow[];
}
function parse(value: unknown): Record {
  const raw = controlObject(value, ['version', 'entries']);
  if (raw.version !== BATCH_SELLER_REGISTRY.version) return sessionFail();
  const peers = new Set<string>();
  const entries = controlArray(
    raw.entries,
    BATCH_SELLER_REGISTRY.maxBuyers,
  ).map((value) => {
    const row = controlObject(value, ['buyerNodeId', 'legacy', 'prepared']);
    const buyerNodeId = controlHex(row.buyerNodeId);
    const prepared = row.prepared === null ? null : termsFor(row.prepared);
    if (
      typeof row.legacy !== 'boolean' ||
      peers.has(buyerNodeId) ||
      (prepared && (row.legacy || prepared.buyerNodeId !== buyerNodeId))
    )
      return sessionFail();
    peers.add(buyerNodeId);
    return { buyerNodeId, legacy: row.legacy, prepared };
  });
  if (entries.filter((row) => row.legacy).length > 1) return sessionFail();
  return { version: BATCH_SELLER_REGISTRY.version, entries };
}
export function sellerRegistryPaths(
  paths: BatchSellerPaths,
  row: SellerRegistryRow,
) {
  return row.legacy
    ? paths.legacy
    : batchSellerBuyerPaths(paths, row.buyerNodeId);
}
async function children(paths: BatchSellerPaths, entries: SellerRegistryRow[]) {
  let found;
  try {
    found = await opendir(paths.children);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  for await (const entry of found) {
    if (!entry.isDirectory()) return sessionFail(SESSION_CODES.UNVERIFIED);
    const own = batchSellerBuyerPaths(paths, entry.name);
    if (!entries.some((row) => !row.legacy && row.buyerNodeId === entry.name)) {
      const stored = await inspectBatchSession(own);
      if (
        stored &&
        (!stored.archivedProof || stored.terms.buyerNodeId !== entry.name)
      )
        return sessionFail(SESSION_CODES.UNVERIFIED);
    }
  }
}
async function load(paths: BatchSellerPaths) {
  const raw = await withBatchState(paths, () =>
    readPrivateFile(paths.state, BATCH_SELLER_REGISTRY.stateBytes),
  );
  const legacy = await readBatchRecord(paths.legacy);
  const record =
    raw === undefined
      ? {
          version: BATCH_SELLER_REGISTRY.version,
          entries: legacy
            ? [
                {
                  buyerNodeId: legacy.terms.buyerNodeId,
                  legacy: true,
                  prepared: null,
                },
              ]
            : [],
        }
      : parse(JSON.parse(raw));
  const imported = record.entries.find((row) => row.legacy);
  if (
    (legacy &&
      imported?.buyerNodeId !== legacy.terms.buyerNodeId &&
      (imported || !storedBatchSession(legacy).archivedProof)) ||
    (imported && !legacy)
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  await children(paths, record.entries);
  return { record, legacyPeer: legacy?.terms.buyerNodeId };
}
export async function openSellerRegistryStore(
  paths: BatchSellerPaths,
  now: () => number,
) {
  await ensurePrivatePaymentPaths(paths);
  const lock = await acquireProcessLock(paths.lock);
  let record: Record;
  let legacyPeer: string | undefined;
  let disposed = false;
  let poisoned = false;
  try {
    ({ record, legacyPeer } = await load(paths));
  } catch (error) {
    await lock.release();
    throw error;
  }
  function read() {
    if (disposed || poisoned) return sessionFail(SESSION_CODES.UNAVAILABLE);
    return structuredClone(record);
  }
  async function update(change: (draft: Record) => void) {
    const draft = read();
    await lock.verify();
    change(draft);
    const next = parse(draft);
    try {
      await withBatchState(paths, () =>
        writePrivateFile(
          paths.state,
          JSON.stringify(next),
          BATCH_SELLER_REGISTRY.stateBytes,
        ),
      );
      record = next;
    } catch (error) {
      if (
        error instanceof PaymentSessionError &&
        error.code === SESSION_CODES.BUSY
      )
        throw error;
      poisoned = true;
      return sessionFail(SESSION_CODES.UNAVAILABLE);
    }
  }
  async function prepare(row: SellerRegistryRow) {
    if (row.prepared === null) return;
    await seed(paths, row, now);
    await update((draft) => {
      draft.entries.find(
        (entry) => entry.buyerNodeId === row.buyerNodeId,
      )!.prepared = null;
    });
  }
  try {
    for (const row of record.entries) await prepare(row);
  } catch (error) {
    await lock.release();
    throw error;
  }
  return {
    read,
    legacyPeer,
    update,
    prepare,
    async dispose() {
      disposed = true;
      await lock.release();
    },
  };
}

async function seed(
  paths: BatchSellerPaths,
  row: SellerRegistryRow,
  now: () => number,
) {
  const terms = row.prepared;
  if (terms === null) return;
  const own = sellerRegistryPaths(paths, row);
  await ensurePrivatePaymentPaths(own);
  const existing = await readBatchRecord(own);
  if (
    existing &&
    canonicalJson(existing) !==
      canonicalJson(initialRecord(terms, existing.lastActivity))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (!existing)
    await withBatchState(own, () =>
      writePrivateFile(
        own.state,
        JSON.stringify(initialRecord(terms, now())),
        BATCH_SESSION_DEFAULTS.stateBytes,
        { exclusive: true },
      ),
    );
}
