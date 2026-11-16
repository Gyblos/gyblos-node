// Owns cached journal replay, exclusive updates and occasional atomic compaction; no upload is performed.
import { HOME_ENVIRONMENT, receiptPathsIn } from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlHex,
  controlInteger,
} from '@gyblos/protocol/control-validation';

import { RECEIPT_STORAGE, RECEIPT_UPLOAD } from './constants';
import { assertRoleHome } from './home';
import {
  appendReceiptFile,
  readReceiptFile,
  receiptBoundary,
  receiptDirectory,
  receiptFileRevision,
  receiptLock,
  receiptSignal,
  receiptUnavailable,
  writeReceiptFile,
} from './receipt-file';
import {
  parseReceiptJournal,
  receiptSnapshot,
  type ReceiptMutation,
} from './receipt-upload-journal';
import {
  trimUploaded,
  uploadHealth,
  type UploadEntry,
  type UploadState,
} from './receipt-upload-state';
import type {
  ReceiptStoreOptions,
  ReceiptUploadHealth,
} from './receipt-upload-types';

type Disk = NonNullable<Awaited<ReturnType<typeof readReceiptFile>>>;
function contextOf(options: ReceiptStoreOptions) {
  const role = options.role;
  if (role !== P2P_ROLES.BUYER && role !== P2P_ROLES.SELLER)
    receiptUnavailable();
  const nodeId = controlHex(options.nodeId);
  const environment = {
    [HOME_ENVIRONMENT.product]: options.environment[HOME_ENVIRONMENT.product],
  };
  const bounded = (value: number | undefined, maximum: number) =>
    controlInteger(value ?? maximum, 1, maximum);
  return {
    role,
    nodeId,
    environment,
    paths: receiptPathsIn(environment, role),
    now: options.now ?? Date.now,
    maxEntries: bounded(options.maxEntries, RECEIPT_STORAGE.maxEntries),
    maxBytes: bounded(options.maxBytes, RECEIPT_STORAGE.maxBytes),
    retentionMs: bounded(options.retentionMs, RECEIPT_STORAGE.retentionMs),
    maxPendingEntries: bounded(
      options.maxPendingEntries,
      RECEIPT_UPLOAD.maxPendingEntries,
    ),
    maxPendingBytes: bounded(
      options.maxPendingBytes,
      RECEIPT_UPLOAD.maxPendingBytes,
    ),
  };
}
type JournalContext = ReturnType<typeof contextOf>;
interface CachedJournal {
  state: UploadState;
  disk: Disk | undefined;
  legacy: boolean;
}
async function publishReceiptMutation(
  previous: CachedJournal,
  context: JournalContext,
  state: UploadState,
  mutation: ReceiptMutation,
  signal?: AbortSignal,
) {
  const text = canonicalJson(mutation) + '\n';
  let disk: Disk;
  if (
    !previous.disk ||
    previous.legacy ||
    previous.disk.complete + Buffer.byteLength(text) >
      Math.min(
        RECEIPT_UPLOAD.maxLogBytes,
        Math.max(
          RECEIPT_UPLOAD.compactAfterBytes,
          (uploadHealth(state, context).pendingBytes + context.maxBytes) *
            RECEIPT_UPLOAD.compactionRatio,
        ),
      )
  ) {
    const snapshot = receiptSnapshot(state, context.role, context.nodeId);
    await writeReceiptFile(
      context.paths.state,
      snapshot,
      signal,
      previous.disk?.revision,
    );
    const revision = await receiptFileRevision(context.paths.state);
    if (!revision) receiptUnavailable();
    disk = {
      text: '',
      revision,
      complete: Buffer.byteLength(snapshot),
      size: Buffer.byteLength(snapshot),
    };
  } else {
    disk = {
      text: '',
      ...(await appendReceiptFile(
        context.paths.state,
        text,
        previous.disk.revision,
        previous.disk.complete,
        signal,
      )),
    };
  }
  return disk;
}

async function loadReceiptState(
  context: JournalContext,
  cached: CachedJournal | undefined,
  signal?: AbortSignal,
) {
  receiptSignal(signal);
  await assertRoleHome(context.role, context.environment);
  await receiptDirectory(context.paths.directory);
  const revision = cached
    ? await receiptFileRevision(context.paths.state)
    : undefined;
  if (!cached || cached.disk?.revision !== revision) {
    const disk = await readReceiptFile(context.paths.state);
    const parsed = disk
      ? await parseReceiptJournal(
          disk.text,
          context.role,
          context.nodeId,
          disk.size - disk.complete,
          signal,
        )
      : {
          legacy: false,
          state: {
            entries: new Map<string, UploadEntry>(),
            rejectedWrites: 0,
          },
        };
    cached = { ...parsed, disk };
  }
  receiptSignal(signal);
  return cached;
}

export function receiptJournal(options: ReceiptStoreOptions) {
  const context = contextOf(options);
  let cached:
    { state: UploadState; disk: Disk | undefined; legacy: boolean } | undefined;
  let current: ReceiptUploadHealth | undefined;
  async function read(signal?: AbortSignal) {
    return receiptBoundary(async () => {
      cached = await loadReceiptState(context, cached, signal);
      current = uploadHealth(
        trimUploaded(cached.state, context, controlInteger(context.now()))
          .state,
        context,
      );
      return cached;
    });
  }
  async function persist(
    state: UploadState,
    mutation: ReceiptMutation,
    signal?: AbortSignal,
  ) {
    receiptSignal(signal);
    if (!cached) receiptUnavailable();
    const disk = await publishReceiptMutation(
      cached,
      context,
      state,
      mutation,
      signal,
    );
    cached = { state, disk, legacy: false };
    current = uploadHealth(state, context);
  }
  async function transact<T>(
    run: (
      state: UploadState,
      evicted: string[],
      signal?: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ) {
    return receiptBoundary(async () => {
      await read(signal);
      const release = await receiptLock(context.paths.lock);
      try {
        const previous = await read(signal);
        const trimmed = trimUploaded(
          previous.state,
          context,
          controlInteger(context.now()),
        );
        return await run(trimmed.state, trimmed.evicted, signal);
      } finally {
        await release();
      }
    });
  }
  return { context, read, persist, transact, current: () => current };
}
