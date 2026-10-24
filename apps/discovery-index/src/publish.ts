// Owns acceptance of one published record: decode, allowlist, verify, replay and rate checks, then an atomic put.
// It stores only signed public data and never sees or keeps the client address.
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { PublicRecordV2 } from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';

import { readPublishBody } from './body.js';
import {
  DISCOVERY_INDEX_LIMITS,
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
} from './constants.js';
import { indexFail } from './errors.js';
import { allowed, type ResolvedLimiters } from './limits.js';
import {
  allowlistWithin,
  publisherAllowed,
  type DiscoveryPublishers,
} from './publishers.js';
import type { DiscoveryStorage, StoredEntry } from './storage.js';
import { verifyAgainstStored, verifySelfSigned } from './verify.js';

export interface PublishContext {
  storage: DiscoveryStorage;
  limiters: ResolvedLimiters;
  publishers: DiscoveryPublishers;
  now: number;
  maxNodes: number;
  // Throttled pruning, run only before admitting a new NodeId.
  prune: (now: number) => Promise<void>;
}

async function storedEntry(
  record: PublicRecordV2,
  signature: string,
  json: string,
): Promise<StoredEntry> {
  const catalog = record.kind === PUBLIC_RECORD_KINDS.CATALOG;
  return {
    kind: record.kind,
    nodeId: record.nodeId,
    owner: record.owner,
    sequence: record.sequence,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    digest: catalog ? await catalogDigestV2(record) : record.catalogDigest,
    models: catalog
      ? [...new Set(record.models.map((model) => model.modelId))]
      : [],
    signature,
    // Keep the high-water mark well past the longest record lifetime.
    retainUntil: record.expiresAt + DISCOVERY_INDEX_LIMITS.retentionMs,
    // Stored verbatim exactly as published (compact, checked by readPublishBody).
    json,
  };
}

// Throws IndexError with a static code; storage failures propagate (503).
export async function acceptRecord(
  bytes: ArrayBuffer,
  context: PublishContext,
) {
  const { storage, now } = context;
  const { envelope, json } = readPublishBody(bytes);
  // The claimed NodeId is refused before the signature, storage or the per-NodeId limit,
  // so an unlisted publisher costs one parse and consumes no NodeId allowance.
  if (!publisherAllowed(context.publishers, envelope))
    indexFail(INDEX_ERRORS.PUBLISH_NOT_ALLOWED);
  const { record, signature } = await verifySelfSigned(envelope, now);
  // Stale records are rejected before the per-NodeId limit, so replaying a seller's public
  // records cannot exhaust its allowance; the signature already proved the NodeId.
  const state = await storage.state(record.nodeId);
  if (state && state.lastSequence >= record.sequence)
    indexFail(INDEX_ERRORS.STALE_RECORD);
  if (
    !(await allowed(context.limiters[DISCOVERY_LIMITERS.NODE], record.nodeId))
  )
    indexFail(INDEX_ERRORS.RATE_LIMITED);
  await verifyAgainstStored(envelope, record, state?.catalog ?? null, now);
  if (!state) {
    await context.prune(now);
    if (
      !allowlistWithin(context.publishers, context.maxNodes) &&
      (await storage.nodeCount()) >= context.maxNodes
    )
      indexFail(INDEX_ERRORS.RATE_LIMITED);
  }
  if (!(await storage.put(await storedEntry(record, signature, json))))
    indexFail(INDEX_ERRORS.STALE_RECORD);
}
