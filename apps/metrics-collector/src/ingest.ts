// Owns one upload's acceptance, cheapest checks first: strict JSON, envelope parse (structure and party
// binding), the envelope signature, the clock window, per-node admission, then each receipt verified
// once by the public receipt policy, and one atomic write.
import {
  classifyPublicReceipt,
  mergePublicReceipt,
} from '@gyblos/core/public-receipts';
import { canonicalJson } from '@gyblos/protocol';
import { verifyReceiptUploadEnvelope } from '@gyblos/protocol/receipt-upload';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_LIMITS,
  ENVELOPE_KINDS,
  HEX_RADIX,
} from './constants';
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
  // Per-uploader admission, consulted only after the envelope signature verifies.
  admitNode(uploaderNodeId: string): Promise<boolean>;
  // The shared write budget, spent only by fully verified uploads right before the write.
  admitWrite(): Promise<boolean>;
}
export interface IngestResult {
  receivedAt: number;
  accepted: number;
}

export class StaleUploadError extends Error {
  constructor(readonly serverTime: number) {
    super(COLLECTOR_ERRORS.STALE_UPLOAD);
    this.name = 'StaleUploadError';
  }
}

export function decode(bytes: Uint8Array): unknown {
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

export async function envelopeId(signature: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)),
  );
  return Array.from(digest, (byte) =>
    byte.toString(HEX_RADIX).padStart(2, '0'),
  ).join('');
}

// Parses and checks only the envelope signature (one Ed25519 verification), no receipt work yet.
async function verifiedEnvelope(value: unknown) {
  try {
    return await verifyReceiptUploadEnvelope(value);
  } catch (error) {
    return verificationFailure(error);
  }
}

export async function ingestUpload(
  bytes: Uint8Array,
  context: IngestContext,
): Promise<IngestResult> {
  if (bytes.byteLength > COLLECTOR_LIMITS.maxBodyBytes)
    return collectorReject(COLLECTOR_ERRORS.PAYLOAD_TOO_LARGE);
  const { upload, signature } = await verifiedEnvelope(decode(bytes));
  if (Math.abs(context.now - upload.sentAt) > COLLECTOR_LIMITS.clockWindowMs)
    throw new StaleUploadError(context.now);
  if (!(await context.admitNode(upload.uploaderNodeId)))
    return collectorReject(COLLECTOR_ERRORS.RATE_LIMITED);

  let entries;
  try {
    // The policy verifies each receipt's node signatures and binding; this is the only receipt check.
    entries = await Promise.all(
      upload.items.map((item) => classifyPublicReceipt(item.receipt)),
    );
  } catch (error) {
    return verificationFailure(error);
  }
  if (!(await context.admitWrite()))
    return collectorReject(COLLECTOR_ERRORS.RATE_LIMITED);
  // The pre-read only labels reports; storage decides first versions and conflicts atomically.
  const stored = await context.storage.readEntries(
    entries.map((entry) => entry.key),
  );
  const id = await envelopeId(signature);
  const receipts: ReceiptWrite[] = [];
  const reports: ReportRow[] = [];
  entries.forEach((incoming, index) => {
    const item = upload.items[index]!;
    const { merge } = mergePublicReceipt(
      stored.get(incoming.key) ?? null,
      incoming,
    );
    receipts.push({ role: upload.role, incoming });
    reports.push({
      envelopeId: id,
      key: incoming.key,
      role: upload.role,
      fingerprint: incoming.fingerprint,
      sellerDigest: incoming.sellerDigest,
      buyerDigest: incoming.buyerDigest,
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
        kind: ENVELOPE_KINDS.RECEIPTS,
        uploaderNodeId: upload.uploaderNodeId,
        role: upload.role,
        client: upload.client,
        sentAt: upload.sentAt,
        nonce: upload.nonce,
        itemCount: upload.items.length,
        signature,
        json: canonicalJson({ upload, signature }),
        receivedAt: context.now,
      },
      reports,
      receipts,
    },
    context.now,
  );
  if (result === COMMIT_RESULTS.REPLAYED)
    return collectorReject(COLLECTOR_ERRORS.REPLAYED_UPLOAD);
  return { receivedAt: context.now, accepted: receipts.length };
}
