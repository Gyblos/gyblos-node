// Owns private snapshot I/O and cancellable staged replacement under the runtime's process lock.
// It never selects a home, clears uncertain state or follows a receipt to another system.
import { constants } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { FILE_MODES } from '@gyblos/config';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import {
  RECEIPT_FILE_CODES,
  RECEIPT_FILE_FORMAT,
  RECEIPT_FILE_LIMITS,
} from './constants';
import {
  receiptFileBoundary,
  ReceiptFileError,
  receiptFileFail,
  receiptFileSignal,
} from './receipt-store-errors';
import { parseReceiptFile, snapshotText } from './receipt-store-schema';
import type {
  ReceiptFileSettings,
  ReceiptFileState,
  ReceiptSnapshotState,
} from './receipt-store-state';
import type { ReceiptFileOptions } from './receipt-store-types';

function capacity(value: number | undefined, maximum: number) {
  const selected = value ?? maximum;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
    return receiptFileFail(RECEIPT_FILE_CODES.INVALID_OPTIONS);
  return selected;
}
function settings(options: ReceiptFileOptions): ReceiptFileSettings {
  if (!options || typeof options !== 'object')
    return receiptFileFail(RECEIPT_FILE_CODES.INVALID_OPTIONS);
  if (
    typeof options.path !== 'string' ||
    !isAbsolute(options.path) ||
    resolve(options.path) !== options.path ||
    dirname(options.path) === options.path
  )
    return receiptFileFail(RECEIPT_FILE_CODES.INVALID_OPTIONS);
  return {
    path: options.path,
    maxEntries: capacity(options.maxEntries, RECEIPT_FILE_LIMITS.entries),
    maxBytes: capacity(options.maxBytes, RECEIPT_FILE_LIMITS.bytes),
    maxPending: capacity(options.maxPending, RECEIPT_FILE_LIMITS.pending),
  };
}
async function refuseStage(path: string) {
  try {
    await lstat(path + RECEIPT_FILE_FORMAT.stageSuffix);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
}
async function initialize(
  path: string,
  parent: FileHandle,
  maxBytes: number,
  text: string,
) {
  if (Buffer.byteLength(text) > maxBytes)
    receiptFileFail(RECEIPT_FILE_CODES.INVALID_OPTIONS);
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    FILE_MODES.privateFile,
  );
  try {
    await file.writeFile(text);
    await file.sync();
    await parent.sync();
  } finally {
    await file.close();
  }
}
export async function assertReceiptFile(state: ReceiptSnapshotState) {
  await state.lock.verify();
  const opened = await state.parent.stat();
  const named = await lstat(dirname(state.settings.path));
  if (
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    named.dev !== opened.dev ||
    named.ino !== opened.ino ||
    (named.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateDirectory ||
    (process.getuid && named.uid !== process.getuid())
  )
    receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
  const actual = await readPrivateFile(
    state.settings.path,
    state.settings.maxBytes,
  );
  if (actual !== state.text) receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
}
async function load(
  settings: ReceiptFileSettings,
  parent: FileHandle,
  lock: ProcessLock,
): Promise<ReceiptSnapshotState> {
  const text = await readPrivateFile(settings.path, settings.maxBytes);
  if (text === undefined)
    return receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
  const state = { settings, parent, lock, text, broken: false };
  await assertReceiptFile(state);
  return state;
}
export async function releaseReceiptSnapshot(state: ReceiptSnapshotState) {
  try {
    await state.lock.release();
  } finally {
    await state.parent.close();
  }
}
export async function openReceiptState(
  options: ReceiptFileOptions,
  create: boolean,
): Promise<ReceiptFileState> {
  return receiptFileBoundary(async () => {
    const state = await openReceiptSnapshot(options, create, snapshotText([]));
    try {
      const entries = await parseReceiptFile(
        state.text,
        state.settings.maxEntries,
        state.settings.maxBytes,
      );
      return {
        ...state,
        entries,
        tail: Promise.resolve(),
        pending: 0,
        closed: false,
      };
    } catch (error) {
      await releaseReceiptSnapshot(state);
      throw error;
    }
  });
}
export function openReceiptSnapshot(
  options: ReceiptFileOptions,
  create: boolean,
  initial: string,
) {
  const selected = settings(options);
  return receiptFileBoundary(async () => {
    await ensurePrivateDirectory(dirname(selected.path));
    const lock = await acquireProcessLock(
      selected.path + RECEIPT_FILE_FORMAT.lockSuffix,
    );
    let parent: FileHandle | undefined;
    try {
      parent = await open(
        dirname(selected.path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await refuseStage(selected.path);
      if (create)
        await initialize(selected.path, parent, selected.maxBytes, initial);
      return await load(selected, parent, lock);
    } catch (error) {
      try {
        await lock.release();
      } finally {
        await parent?.close();
      }
      throw error;
    }
  });
}
async function removeOwnedStage(file: FileHandle, path: string) {
  let named;
  try {
    named = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  const owned = await file.stat();
  if (named.dev !== owned.dev || named.ino !== owned.ino)
    return receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
  await unlink(path);
}
export async function replaceReceiptFile(
  state: ReceiptSnapshotState,
  text: string,
  signal?: AbortSignal,
) {
  const stage = state.settings.path + RECEIPT_FILE_FORMAT.stageSuffix;
  let file: FileHandle | undefined;
  try {
    file = await open(
      stage,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      FILE_MODES.privateFile,
    );
    await file.writeFile(text);
    await file.sync();
    await assertReceiptFile(state);
    receiptFileSignal(signal);
    // Dispatching rename is the commit boundary; an in-flight native rename cannot be cancelled.
    await rename(stage, state.settings.path);
    await state.parent.sync();
  } catch (error) {
    if (!(
      error instanceof ReceiptFileError &&
      error.code === RECEIPT_FILE_CODES.CANCELLED
    ))
      state.broken = true;
    throw error;
  } finally {
    if (file) {
      try {
        await removeOwnedStage(file, stage);
      } catch (error) {
        state.broken = true;
        throw error;
      } finally {
        await file.close();
      }
    }
  }
}
