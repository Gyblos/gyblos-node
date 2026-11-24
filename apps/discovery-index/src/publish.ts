// Owns acceptance of one published record: decode, allowlist or registration, verify, replay and rate checks,
// then an atomic put.
// It stores only signed public data and never sees or keeps the client address.
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { PublicRecordV2 } from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';
import { verifiedSellerVersion } from '@gyblos/protocol/seller-version';

import { readPublishBody } from './body';
import { DISCOVERY_INDEX_LIMITS, INDEX_ERRORS } from './constants';
import { indexFail } from './errors';
import {
  claimedNodeId,
  publisherAllowed,
  type DiscoveryPublishers,
} from './publishers';
import type { RegistrationStore } from './registration-store';
import type { DiscoveryStorage, StoredEntry } from './storage';
import { verifyAgainstStored, verifySelfSigned } from './verify';

export interface PublishContext {
  storage: DiscoveryStorage;
  // At least one of the two is present: the allowlist secret, the registered NodeIds, or both.
  publishers: DiscoveryPublishers | undefined;
  registrations: RegistrationStore | undefined;
  now: number;
  maxNodes: number;
  maxPublications: number;
  // Throttled pruning, run only before admitting a new NodeId.
  prune: (now: number) => Promise<void>;
  // Records an accepted presence for public uptime.
  markSeen: (nodeId: string, now: number) => Promise<void>;
}

const HEX_RADIX = 16;

async function offerContent(models: readonly unknown[]) {
  const json = JSON.stringify(models);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(json),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(HEX_RADIX).padStart(2, '0'),
  ).join('');
  return { hash, json };
}

async function storedEntry(
  record: PublicRecordV2,
  signature: string,
  json: string,
  admission: StoredEntry['admission'],
): Promise<StoredEntry> {
  const catalog = record.kind === PUBLIC_RECORD_KINDS.CATALOG;
  return {
    admission,
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
    ...(catalog ? { offers: await offerContent(record.models) } : {}),
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
  versionProof?: string,
) {
  const { storage, now } = context;
  const { envelope, json } = readPublishBody(bytes);
  // The claimed NodeId is refused before the signature, record storage or the per-NodeId limit, so
  // an unlisted publisher costs one parse (plus one registration read when registrations are on)
  // and consumes no NodeId allowance.
  if (!(await mayPublish(context, envelope)))
    indexFail(INDEX_ERRORS.PUBLISH_NOT_ALLOWED);
  const { record, signature } = await verifySelfSigned(envelope, now);
  // Reject known stale records cheaply. Storage checks freshness and consumes the NodeId
  // allowance atomically, so concurrent copies cannot spend it twice.
  const state = await storage.state(record.nodeId);
  if (state && state.lastSequence >= record.sequence)
    indexFail(INDEX_ERRORS.STALE_RECORD);
  await verifyAgainstStored(envelope, record, state?.catalog ?? null, now);
  if (!state) {
    await context.prune(now);
  }
  if (
    !(await storage.put({
      ...(await storedEntry(record, signature, json, {
        now,
        maxNodes: context.maxNodes,
        maxPublications: context.maxPublications,
      })),
      version: await verifiedSellerVersion({ record, signature }, versionProof),
    }))
  )
    indexFail(INDEX_ERRORS.STALE_RECORD);
  // Uptime counts only presence the index accepted, at the index's own clock. It is best effort: the
  // record is already stored, so a failed uptime write must not make the seller republish it.
  if (record.kind === PUBLIC_RECORD_KINDS.PRESENCE)
    await context.markSeen(record.nodeId, now).catch(() => undefined);
}
