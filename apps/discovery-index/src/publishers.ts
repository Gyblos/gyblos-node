// Owns who may publish to the index: parsing the allowlist secret and the cheap claimed-NodeId check.
// It never verifies signatures, touches storage or limiters, and never exposes the listed NodeIds.
import {
  PUBLISH_ALLOWLIST,
  PUBLISH_MODES,
  type PublishMode,
} from './constants.js';

// Undefined (no publishers configured) means publishing is closed.
export type DiscoveryPublishers =
  | { mode: typeof PUBLISH_MODES.OPEN }
  | { mode: typeof PUBLISH_MODES.ALLOWLIST; nodeIds: ReadonlySet<string> };

// `*` opens publishing; otherwise every comma-separated entry (whitespace trimmed) must be a
// lowercase 64-hex NodeId, at most maxEntries of them. Anything else is undefined (closed).
export function parsePublishAllowlist(
  value: unknown,
): DiscoveryPublishers | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === PUBLISH_ALLOWLIST.open) return { mode: PUBLISH_MODES.OPEN };
  const entries = text.split(PUBLISH_ALLOWLIST.separator);
  if (entries.length > PUBLISH_ALLOWLIST.maxEntries) return undefined;
  const nodeIds = new Set<string>();
  for (const entry of entries) {
    const nodeId = entry.trim();
    if (!PUBLISH_ALLOWLIST.nodeId.test(nodeId)) return undefined;
    nodeIds.add(nodeId);
  }
  return { mode: PUBLISH_MODES.ALLOWLIST, nodeIds };
}

export function publishModeOf(
  publishers: DiscoveryPublishers | undefined,
): PublishMode {
  return publishers?.mode ?? PUBLISH_MODES.CLOSED;
}

// The NodeId the unverified envelope claims, or undefined when it has none.
function claimedNodeId(envelope: unknown): unknown {
  const record: unknown =
    envelope && typeof envelope === 'object'
      ? Reflect.get(envelope, 'record')
      : undefined;
  return record && typeof record === 'object'
    ? Reflect.get(record, 'nodeId')
    : undefined;
}

// Checked before the signature: a claim is enough to refuse, and an allowed claim is still
// proven by the self-signature afterwards.
export function publisherAllowed(
  publishers: DiscoveryPublishers,
  envelope: unknown,
) {
  if (publishers.mode === PUBLISH_MODES.OPEN) return true;
  const nodeId = claimedNodeId(envelope);
  return typeof nodeId === 'string' && publishers.nodeIds.has(nodeId);
}
