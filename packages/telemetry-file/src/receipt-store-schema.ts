// Verifies bounded private snapshots and entry fingerprints through the existing core policy; no I/O.
import {
  prepareCollectedReceipt,
  type PrivateFreeReceipt,
} from '@gyblos/core/receipt-collector';
import { canonicalJson } from '@gyblos/protocol';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import {
  controlArray,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';

import {
  RECEIPT_FILE_CODES,
  RECEIPT_FILE_FORMAT,
  RECEIPT_FILE_LIMITS,
} from './constants';
import { receiptFileFail } from './receipt-store-errors';

export interface PendingReceipt {
  key: string;
  fingerprint: string;
  body: Uint8Array;
}
export function snapshotText(entries: readonly PrivateFreeReceipt[]) {
  return (
    canonicalJson({ version: RECEIPT_FILE_FORMAT.version, entries }) + '\n'
  );
}
export function captureReceipt(value: unknown): PendingReceipt {
  try {
    const input = controlObject(value, ['key', 'fingerprint', 'receipt']);
    if (
      typeof input.key !== 'string' ||
      input.key.length > RECEIPT_FILE_LIMITS.keyCharacters
    )
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    return {
      key: input.key,
      fingerprint: controlHex(input.fingerprint),
      body: encodeControlFrame(input.receipt).slice(CONTROL_LIMITS.prefixBytes),
    };
  } catch {
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  }
}
export async function verifyStoredReceipt(
  input: PendingReceipt,
): Promise<PrivateFreeReceipt> {
  try {
    const entry = await prepareCollectedReceipt(input.body);
    if (entry.key !== input.key || entry.fingerprint !== input.fingerprint)
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    return entry;
  } catch {
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  }
}
export async function parseReceiptFile(
  text: string,
  maxEntries: number,
  maxBytes: number,
) {
  try {
    const value: unknown = JSON.parse(text);
    const input = controlObject(value, ['version', 'entries']);
    if (input.version !== RECEIPT_FILE_FORMAT.version)
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    const entries = controlArray(input.entries, maxEntries);
    // The existing bounded walker rejects deep/ambiguous objects before canonical recursion.
    encodeControlFrame(value, maxBytes);
    if (canonicalJson(value) + '\n' !== text)
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    const verified: PrivateFreeReceipt[] = [];
    const keys = new Set<string>();
    for (const entry of entries) {
      const record = await verifyStoredReceipt(captureReceipt(entry));
      if (keys.has(record.key))
        return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
      keys.add(record.key);
      verified.push(record);
    }
    return verified;
  } catch {
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  }
}
