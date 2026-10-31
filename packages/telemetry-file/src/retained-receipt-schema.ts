// Strict retention snapshots keep signed bodies only until expiry and private bounded replay markers afterward.
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
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { RECEIPT_FILE_CODES, RECEIPT_RETENTION } from './constants';
import { receiptFileFail } from './receipt-store-errors';

export interface RetainedReceiptRow {
  key: string;
  fingerprint: string;
  receivedAt: number;
  receipt: PrivateFreeReceipt['receipt'] | null;
}
export interface RetainedReceiptData {
  version: typeof RECEIPT_RETENTION.version;
  retentionMs: number;
  clock: number;
  entries: RetainedReceiptRow[];
}
export const retainedText = (data: RetainedReceiptData) =>
  canonicalJson(data) + '\n';
export function retentionClock(now: () => number) {
  const value = now();
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER - RECEIPT_RETENTION.maximumMs
  )
    return receiptFileFail(RECEIPT_FILE_CODES.INVALID_OPTIONS);
  return value;
}
function identityKey(value: unknown) {
  if (typeof value !== 'string')
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  const fields = controlArray(JSON.parse(value), RECEIPT_RETENTION.keyFields);
  if (
    fields.length !== RECEIPT_RETENTION.keyFields ||
    canonicalJson(fields) !== value
  )
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  controlHex(fields[0]);
  controlHex(fields[1]);
  controlHex(fields[2], CONTROL_LIMITS.requestIdBytes);
  return value;
}
async function retainedRow(
  value: unknown,
  clock: number,
  retentionMs: number,
): Promise<RetainedReceiptRow> {
  const row = controlObject(value, [
    'key',
    'fingerprint',
    'receivedAt',
    'receipt',
  ]);
  const key = identityKey(row.key);
  const fingerprint = controlHex(row.fingerprint);
  const receivedAt = controlInteger(row.receivedAt, 0, clock);
  if (row.receipt === null) {
    if (receivedAt + retentionMs > clock)
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    return { key, fingerprint, receivedAt, receipt: null };
  }
  const verified = await prepareCollectedReceipt(
    new TextEncoder().encode(canonicalJson(row.receipt)),
  );
  if (verified.key !== key || verified.fingerprint !== fingerprint)
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  return { ...verified, receivedAt };
}
export async function parseRetainedReceipts(
  text: string,
  retentionMs: number,
  maxEntries: number,
  maxBytes: number,
): Promise<RetainedReceiptData> {
  try {
    const value: unknown = JSON.parse(text);
    encodeControlFrame(value, maxBytes);
    if (canonicalJson(value) + '\n' !== text)
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    const input = controlObject(value, [
      'version',
      'retentionMs',
      'clock',
      'entries',
    ]);
    if (
      input.version !== RECEIPT_RETENTION.version ||
      input.retentionMs !== retentionMs
    )
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    const clock = controlInteger(
      input.clock,
      0,
      Number.MAX_SAFE_INTEGER - RECEIPT_RETENTION.maximumMs,
    );
    const entries: RetainedReceiptRow[] = [];
    for (const row of controlArray(input.entries, maxEntries))
      entries.push(await retainedRow(row, clock, retentionMs));
    if (new Set(entries.map((row) => row.key)).size !== entries.length)
      return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
    return { version: RECEIPT_RETENTION.version, retentionMs, clock, entries };
  } catch {
    return receiptFileFail(RECEIPT_FILE_CODES.CORRUPT);
  }
}
