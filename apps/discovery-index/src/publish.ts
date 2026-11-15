// Owns acceptance of one published record: decode, allowlist or registration, verify, replay and rate checks,
// then an atomic put.
// It stores only signed public data and never sees or keeps the client address.
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { PublicRecordV2 } from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';

import { readPublishBody } from './body';
import {
  DISCOVERY_INDEX_LIMITS,
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
} from './constants';
import { indexFail } from './errors';
import { allowed, type ResolvedLimiters } from './limits';
import {
  allowlistWithin,
  claimedNodeId,
  publisherAllowed,
  type DiscoveryPublishers,
} from './publishers';
import type { RegistrationStore } from './registration-store';
import type { DiscoveryStorage, StoredEntry } from './storage';
import { verifyAgainstStored, verifySelfSigned } from './verify';

export interface PublishContext {
  storage: DiscoveryStorage;
  limiters: ResolvedLimiters;
  // At least one of the two is present: the allowlist secret, the registered NodeIds, or both.
  publishers: DiscoveryPublishers | undefined;
  registrations: RegistrationStore | undefined;
  now: number;
  maxNodes: number;
  // Throttled pruning, run only before admitting a new NodeId.
  prune: (now: number) => Promise<void>;
  // Records an accepted presence for public uptime.
  markSeen: (nodeId: string, now: number) => Promise<void>;
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

// The allowlist is checked first, so an allowlisted seller never depends on the registration tables.
async function mayPublish(context: PublishContext, envelope: unknown) {
  if (context.publishers && publisherAllowed(context.publishers, envelope))
    return true;
  const nodeId = claimedNodeId(envelope);
  return (
    !!context.registrations &&
    typeof nodeId === 'string' &&
    (await context.registrations.active(nodeId))
  );
}

// Throws IndexError with a static code; storage failures propagate (503).
export async function acceptRecord(
  bytes: ArrayBuffer,
  context: PublishContext,
) {
  const { storage, now } = context;
  const { envelope, json } = readPublishBody(bytes);
  // The claimed NodeId is refused before the signature, record storage or the per-NodeId limit, so
  // an unlisted publisher costs one parse (plus one registration read when registrations are on)
  // and consumes no NodeId allowance.
  if (!(await mayPublish(context, envelope)))
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
    // Registered NodeIds are not bounded by the allowlist, so then the stored count decides.
    const bounded =
      !!context.publishers &&
      !context.registrations &&
      allowlistWithin(context.publishers, context.maxNodes);
    if (!bounded && (await storage.nodeCount()) >= context.maxNodes)
      indexFail(INDEX_ERRORS.RATE_LIMITED);
  }
  if (!(await storage.put(await storedEntry(record, signature, json))))
    indexFail(INDEX_ERRORS.STALE_RECORD);
  // Uptime counts only presence the index accepted, at the index's own clock. It is best effort: the
  // record is already stored, so a failed uptime write must not make the seller republish it.
  if (record.kind === PUBLIC_RECORD_KINDS.PRESENCE)
    await context.markSeen(record.nodeId, now).catch(() => undefined);
}
