// Owns one upload's acceptance: strict JSON, cheap parse and per-node admission before any signature
// work, envelope and receipt verification, the clock window, public receipt policy and one atomic write.
import {
  classifyPublicReceipt,
  mergePublicReceipt,
} from '@gyblos/core/public-receipts';
import { canonicalJson } from '@gyblos/protocol';
import { controlObject } from '@gyblos/protocol/control-validation';
import {
  parseReceiptUpload,
  verifyReceiptUpload,
} from '@gyblos/protocol/receipt-upload';

import { COLLECTOR_ERRORS, COLLECTOR_LIMITS, HEX_RADIX } from './constants';
import { collectorReject, verificationFailure } from './errors';
import {
  COMMIT_RESULTS,
  type CollectorStorage,
  type ReceiptWrite,
  type ReportRow,
} from './storage';

export interface IngestContext {
  storage: CollectorStorage;
  now: number;
  // Per-uploader admission, consulted after the envelope parses and before signature work.
  admitNode(uploaderNodeId: string): Promise<boolean>;
}
export interface IngestResult {
  receivedAt: number;
  items: { merge: ReceiptWrite['merge'] }[];
}

function decode(bytes: ArrayBuffer): unknown {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    return collectorReject();
  }
  // Iterative, so hostile nesting cannot overflow the stack before it is rejected.
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > COLLECTOR_LIMITS.maxJsonDepth) collectorReject();
    if (item.value && typeof item.value === 'object')
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
  return value;
}

async function envelopeId(signature: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)),
  );
  return Array.from(digest, (byte) =>
    byte.toString(HEX_RADIX).padStart(2, '0'),
  ).join('');
}

export class StaleUploadError extends Error {
  constructor(readonly serverTime: number) {
    super(COLLECTOR_ERRORS.STALE_UPLOAD);
    this.name = 'StaleUploadError';
  }
}

export async function ingestUpload(
  bytes: ArrayBuffer,
  context: IngestContext,
): Promise<IngestResult> {
  if (bytes.byteLength > COLLECTOR_LIMITS.maxBodyBytes)
    return collectorReject(COLLECTOR_ERRORS.PAYLOAD_TOO_LARGE);
  const value = decode(bytes);
  let uploaderNodeId: string;
  try {
    const input = controlObject(value, ['upload', 'signature']);
    uploaderNodeId = parseReceiptUpload(input.upload).uploaderNodeId;
  } catch (error) {
    return verificationFailure(error);
  }
  if (!(await context.admitNode(uploaderNodeId)))
    return collectorReject(COLLECTOR_ERRORS.RATE_LIMITED);
  let signed;
  try {
    signed = await verifyReceiptUpload(value);
  } catch (error) {
    return verificationFailure(error);
  }
  const { upload } = signed;
  if (Math.abs(context.now - upload.sentAt) > COLLECTOR_LIMITS.clockWindowMs)
    throw new StaleUploadError(context.now);

  let entries;
  try {
    entries = await Promise.all(
      upload.items.map((item) => classifyPublicReceipt(item.receipt)),
    );
  } catch (error) {
    return verificationFailure(error);
  }
  const stored = await context.storage.readEntries(
    entries.map((entry) => entry.key),
  );
  const id = await envelopeId(signed.signature);
  const receipts: ReceiptWrite[] = [];
  const reports: ReportRow[] = [];
  entries.forEach((incoming, index) => {
    const item = upload.items[index]!;
    const { merge, entry } = mergePublicReceipt(
      stored.get(incoming.key) ?? null,
      incoming,
    );
    receipts.push({ role: upload.role, merge, stored: entry, incoming });
    reports.push({
      envelopeId: id,
      key: incoming.key,
      role: upload.role,
      fingerprint: incoming.fingerprint,
      merge,
      storedAt: item.storedAt,
      startedAt: item.startedAt,
      offerJson: item.offer ? canonicalJson(item.offer) : null,
    });
  });
  const result = await context.storage.commit(
    {
      envelope: {
        id,
        upload,
        signature: signed.signature,
        json: canonicalJson(signed),
        receivedAt: context.now,
      },
      reports,
      receipts,
    },
    context.now,
  );
  if (result === COMMIT_RESULTS.REPLAYED)
    return collectorReject(COLLECTOR_ERRORS.REPLAYED_UPLOAD);
  return {
    receivedAt: context.now,
    items: receipts.map(({ merge }) => ({ merge })),
  };
}
