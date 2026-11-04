// Private bounded per-role receipt persistence; atomic CAS never overwrites a conflicting attestation.
import { lstat } from 'node:fs/promises';

import {
  HOME_ENVIRONMENT,
  receiptPathsIn,
  type HomeEnvironment,
  type HomeRole,
} from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlHex,
  controlInteger,
} from '@gyblos/protocol/control-validation';
import {
  sellerReceiptDigest,
  verifyReceipt,
  type ReceiptV1,
} from '@gyblos/protocol/receipt';
import type {
  ReceiptStore,
  ReceiptStoreKey,
} from '@gyblos/transport-iroh/receipt-service';

import { RECEIPT_STORAGE } from './constants';
import { assertRoleHome } from './home';
import {
  readReceiptFile,
  receiptDirectory,
  receiptLock,
  receiptSignal,
  receiptUnavailable,
  writeReceiptFile,
} from './receipt-file';
import {
  assertReceiptRole,
  lookupKey,
  parseReceiptSnapshot,
  receiptKey,
  type StoredReceipt,
} from './receipt-store-schema';

export interface ReceiptStoreOptions {
  environment: HomeEnvironment;
  role: HomeRole;
  nodeId: string;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  retentionMs?: number;
}
export interface LocalReceiptStore extends ReceiptStore {
  put(value: unknown, signal?: AbortSignal): Promise<void>;
}
async function applyReceipt(
  entries: StoredReceipt[],
  receipt: ReceiptV1,
  confirm: boolean,
  now: number,
) {
  const key = receiptKey(receipt);
  const old = entries.find((entry) => receiptKey(entry.receipt) === key);
  if (!old) {
    if (confirm) return false;
    entries.push({ storedAt: now, receipt });
    return true;
  }
  if (
    (await sellerReceiptDigest(old.receipt.seller.record)) !==
    (await sellerReceiptDigest(receipt.seller.record))
  )
    return false;
  if (old.receipt.buyer)
    return canonicalJson(old.receipt) === canonicalJson(receipt);
  if (receipt.buyer) old.receipt = receipt;
  return true;
}
function receiptStoreContext(options: ReceiptStoreOptions) {
  const role = options.role;
  if (role !== P2P_ROLES.BUYER && role !== P2P_ROLES.SELLER)
    receiptUnavailable();
  const nodeId = controlHex(options.nodeId);
  const environment = {
    [HOME_ENVIRONMENT.product]: options.environment[HOME_ENVIRONMENT.product],
  };
  return {
    role,
    nodeId,
    environment,
    paths: receiptPathsIn(environment, role),
    now: options.now ?? Date.now,
    maxEntries: controlInteger(
      options.maxEntries ?? RECEIPT_STORAGE.maxEntries,
      1,
      RECEIPT_STORAGE.maxEntries,
    ),
    maxBytes: controlInteger(
      options.maxBytes ?? RECEIPT_STORAGE.maxBytes,
      1,
      RECEIPT_STORAGE.maxBytes,
    ),
    retentionMs: controlInteger(
      options.retentionMs ?? RECEIPT_STORAGE.retentionMs,
      1,
      RECEIPT_STORAGE.retentionMs,
    ),
  };
}
async function persistReceiptSnapshot(
  context: ReturnType<typeof receiptStoreContext>,
  entries: StoredReceipt[],
  signal?: AbortSignal,
) {
  entries.sort(
    (left, right) =>
      left.storedAt - right.storedAt ||
      receiptKey(left.receipt).localeCompare(receiptKey(right.receipt)),
  );
  while (entries.length > context.maxEntries) entries.shift();
  const snapshot = () =>
    canonicalJson({
      schemaVersion: RECEIPT_STORAGE.schemaVersion,
      role: context.role,
      nodeId: context.nodeId,
      entries,
    }) + '\n';
  let text = snapshot();
  while (Buffer.byteLength(text) > context.maxBytes && entries.length > 1) {
    entries.shift();
    text = snapshot();
  }
  if (Buffer.byteLength(text) > context.maxBytes) receiptUnavailable();
  await writeReceiptFile(context.paths.state, text, signal);
}
// Every unexpired verified record, read without the lock.
async function readEntries(
  context: ReturnType<typeof receiptStoreContext>,
  signal?: AbortSignal,
) {
  receiptSignal(signal);
  await assertRoleHome(context.role, context.environment);
  await receiptDirectory(context.paths.directory);
  receiptSignal(signal);
  const now = controlInteger(context.now());
  return (
    await parseReceiptSnapshot(
      await readReceiptFile(context.paths.state),
      context.role,
      context.nodeId,
      now,
      signal,
    )
  ).filter((entry) => now - entry.storedAt < context.retentionMs);
}

// Read-only listing for local reports such as `gyblos seller status`; never writes or takes the lock, and
// a seller that never stored a receipt has no directory, which is not created here.
export async function listReceipts(
  options: ReceiptStoreOptions,
  signal?: AbortSignal,
): Promise<StoredReceipt[]> {
  try {
    const context = receiptStoreContext(options);
    try {
      await lstat(context.paths.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return await readEntries(context, signal);
  } catch {
    return receiptUnavailable();
  }
}

export function openReceiptStore(
  options: ReceiptStoreOptions,
): LocalReceiptStore {
  const context = receiptStoreContext(options);
  const read = (signal?: AbortSignal) => readEntries(context, signal);
  async function update(
    value: unknown,
    confirm: boolean,
    signal?: AbortSignal,
  ) {
    receiptSignal(signal);
    const receipt = await verifyReceipt(value);
    assertReceiptRole(receipt, context.role, context.nodeId);
    if (confirm && !receipt.buyer) return false;
    await assertRoleHome(context.role, context.environment);
    await receiptDirectory(context.paths.directory);
    receiptSignal(signal);
    const release = await receiptLock(context.paths.lock);
    try {
      const entries = await read(signal);
      const now = controlInteger(context.now());
      if (!(await applyReceipt(entries, receipt, confirm, now))) return false;
      await persistReceiptSnapshot(context, entries, signal);
      return true;
    } finally {
      await release();
    }
  }
  return {
    async put(value, signal) {
      try {
        if (!(await update(value, false, signal))) receiptUnavailable();
      } catch {
        receiptUnavailable();
      }
    },
    async confirm(value, signal) {
      try {
        return await update(value, true, signal);
      } catch {
        receiptUnavailable();
      }
    },
    async load(key: ReceiptStoreKey, signal) {
      try {
        const target = lookupKey(key);
        return (await read(signal)).find(
          (entry) => receiptKey(entry.receipt) === target,
        )?.receipt;
      } catch {
        receiptUnavailable();
      }
    },
  };
}
