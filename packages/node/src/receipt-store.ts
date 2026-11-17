// Private per-role receipts and upload acknowledgements; inference and signed formats remain independent.
import { lstat } from 'node:fs/promises';

import { canonicalJson } from '@gyblos/protocol';
import {
  controlHex,
  controlInteger,
} from '@gyblos/protocol/control-validation';
import { sellerReceiptDigest, verifyReceipt } from '@gyblos/protocol/receipt';
import type {
  ReceiptStore,
  ReceiptStoreKey,
} from '@gyblos/transport-iroh/receipt-service';

import { NODE_ERROR_CODES, RECEIPT_UPLOAD } from './constants';
import { NodeError } from './errors';
import {
  receiptBoundary,
  receiptSignal,
  receiptUnavailable,
} from './receipt-file';
import {
  assertReceiptRole,
  lookupKey,
  receiptKey,
  type StoredReceipt,
} from './receipt-store-schema';
import { uploadMatches } from './receipt-upload-journal';
import {
  orderedReceiptEntries,
  receiptFingerprint,
  trimUploaded,
  uploadHealth,
  type UploadEntry,
} from './receipt-upload-state';
import { receiptJournal } from './receipt-upload-storage';
import type {
  ReceiptStoreOptions,
  ReceiptUploadCursor,
  ReceiptUploadHealth,
} from './receipt-upload-types';

export type { ReceiptStoreOptions } from './receipt-upload-types';

export interface LocalReceiptStore extends ReceiptStore {
  put(value: unknown, signal?: AbortSignal): Promise<void>;
  listPending(
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ReceiptUploadCursor[]>;
  markUploaded(
    cursor: Pick<ReceiptUploadCursor, 'key' | 'fingerprint'>,
    confirmedAt: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  uploadHealth(signal?: AbortSignal): Promise<ReceiptUploadHealth>;
  currentUploadHealth?(): ReceiptUploadHealth | undefined;
}
export type ReceiptRuntimeStore = Pick<
  LocalReceiptStore,
  'put' | 'load' | 'confirm' | 'currentUploadHealth'
>;
// Read-only reports never create directories or acquire the update lock.
export async function listReceipts(
  options: ReceiptStoreOptions,
  signal?: AbortSignal,
): Promise<StoredReceipt[]> {
  try {
    const journal = receiptJournal(options);
    try {
      await lstat(journal.context.paths.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const loaded = await journal.read(signal);
    return structuredClone(
      orderedReceiptEntries(
        trimUploaded(
          loaded.state,
          journal.context,
          controlInteger(journal.context.now()),
        ).state,
      ),
    );
  } catch {
    return receiptUnavailable();
  }
}
export async function receiptUploadHealth(
  options: ReceiptStoreOptions,
  signal?: AbortSignal,
): Promise<ReceiptUploadHealth> {
  const journal = receiptJournal(options);
  try {
    await lstat(journal.context.paths.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return uploadHealth(
        { entries: new Map(), rejectedWrites: 0 },
        journal.context,
      );
    return receiptUnavailable();
  }
  await journal.read(signal);
  const health = journal.current();
  if (!health) receiptUnavailable();
  return health;
}

async function updateReceipt(
  journal: ReturnType<typeof receiptJournal>,
  value: unknown,
  confirm: boolean,
  signal?: AbortSignal,
) {
  const context = journal.context;
  receiptSignal(signal);
  const receipt = await verifyReceipt(value);
  assertReceiptRole(receipt, context.role, context.nodeId);
  if (confirm && !receipt.buyer) return false;
  return journal.transact(async (state, evicted) => {
    const key = receiptKey(receipt);
    const old = state.entries.get(key);
    if (!old && confirm) return false;
    if (old) {
      if (
        (await sellerReceiptDigest(old.receipt.seller.record)) !==
        (await sellerReceiptDigest(receipt.seller.record))
      )
        return false;
      if (old.receipt.buyer)
        return canonicalJson(old.receipt) === canonicalJson(receipt);
      if (!receipt.buyer) return true;
    }
    const entry: UploadEntry = {
      storedAt: old?.storedAt ?? controlInteger(context.now()),
      receipt,
      uploadedAt: null,
    };
    if (
      Buffer.byteLength(canonicalJson(entry)) >
      RECEIPT_UPLOAD.reservedEntryBytes
    )
      receiptUnavailable();
    const entries = new Map(state.entries);
    entries.set(key, entry);
    const next = { ...state, entries };
    const health = uploadHealth(next, context);
    if (
      health.pendingEntries > context.maxPendingEntries ||
      health.pendingBytes > context.maxPendingBytes
    ) {
      const rejectedWrites = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.rejectedWrites + 1,
      );
      await journal.persist(
        { ...state, rejectedWrites },
        { entry: null, evicted, rejectedWrites },
        signal,
      );
      throw new NodeError(NODE_ERROR_CODES.RECEIPT_STORAGE_FULL);
    }
    await journal.persist(
      next,
      { entry, evicted, rejectedWrites: state.rejectedWrites },
      signal,
    );
    return true;
  }, signal);
}

function uploadCursor(
  journal: ReturnType<typeof receiptJournal>,
): Pick<
  LocalReceiptStore,
  'listPending' | 'markUploaded' | 'uploadHealth' | 'currentUploadHealth'
> {
  const context = journal.context;
  return {
    async listPending(limit = RECEIPT_UPLOAD.pageSize, signal) {
      const count = controlInteger(limit, 1, RECEIPT_UPLOAD.maxPageSize);
      const loaded = await journal.read(signal);
      return orderedReceiptEntries(loaded.state)
        .filter((entry) => entry.uploadedAt === null)
        .slice(0, count)
        .map((entry) => {
          const record = entry.receipt.seller.record;
          return {
            key: {
              executionRequestId: record.requestId,
              requestDigest: record.requestDigest,
              buyerNodeId: record.buyerNodeId,
              sellerNodeId: record.sellerNodeId,
            },
            fingerprint: receiptFingerprint(entry.receipt),
            storedAt: entry.storedAt,
            receipt: structuredClone(entry.receipt),
          };
        });
    },
    async markUploaded(cursor, confirmedAt, signal) {
      const key = lookupKey(cursor.key);
      const fingerprint = controlHex(cursor.fingerprint);
      const at = controlInteger(confirmedAt);
      return journal.transact(async (state, evicted) => {
        const old = state.entries.get(key);
        if (!uploadMatches(old, fingerprint) || !old) return false;
        if (old.uploadedAt !== null) return true;
        const entry = { ...old, uploadedAt: at };
        const entries = new Map(state.entries);
        entries.set(key, entry);
        const trimmed = trimUploaded(
          { ...state, entries },
          context,
          controlInteger(context.now()),
        );
        // Persist the acknowledgement before retention removes it; replay never deletes a pending body.
        await journal.persist(
          { ...state, entries },
          { entry, evicted, rejectedWrites: state.rejectedWrites },
          signal,
        );
        if (trimmed.evicted.length)
          await journal.persist(
            trimmed.state,
            {
              entry: null,
              evicted: trimmed.evicted,
              rejectedWrites: state.rejectedWrites,
            },
            signal,
          );
        return true;
      }, signal);
    },
    async uploadHealth(signal) {
      await journal.read(signal);
      const health = journal.current();
      if (!health) receiptUnavailable();
      return { ...health };
    },
    currentUploadHealth: () => {
      const current = journal.current();
      return current ? { ...current } : undefined;
    },
  };
}

export function openReceiptStore(
  options: ReceiptStoreOptions,
): LocalReceiptStore {
  const journal = receiptJournal(options);
  const context = journal.context;
  return {
    ...uploadCursor(journal),
    async put(value, signal) {
      try {
        if (!(await updateReceipt(journal, value, false, signal)))
          receiptUnavailable();
      } catch (error) {
        if (
          error instanceof NodeError &&
          error.code === NODE_ERROR_CODES.RECEIPT_STORAGE_FULL
        )
          throw error;
        receiptUnavailable();
      }
    },
    async confirm(value, signal) {
      return receiptBoundary(() => updateReceipt(journal, value, true, signal));
    },
    async load(key: ReceiptStoreKey, signal) {
      try {
        const target = lookupKey(key);
        const loaded = await journal.read(signal);
        return structuredClone(
          trimUploaded(
            loaded.state,
            context,
            controlInteger(context.now()),
          ).state.entries.get(target)?.receipt,
        );
      } catch {
        return receiptUnavailable();
      }
    },
  };
}
