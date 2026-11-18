// Owns GET /v1/network: every seller the index knows and whether it is online now, so anyone can count
// the network's online, offline and unpublished sellers. Registered NodeIds are already public on chain
// (the 8004 registry binds each one to its owner), so they are listed even before they publish; revoked
// ones are not. A seller admitted without a registration (the allowlist) is listed once seen within the
// last 30 days. Takes no parameters; cached like a sellers page. Built only from records the index
// verified and from its own registrations; no IP, contact, owner or country is returned.
import {
  INDEX_ERRORS,
  NETWORK,
  NETWORK_STATES,
  type NetworkState,
} from './constants';
import { indexFail } from './errors';
import type { RegistrationStore } from './registration-store';
import type { CatalogStatusRow, DiscoveryStorage } from './storage';
import { reportedHour, type Sighting } from './uptime';

interface NetworkNode {
  nodeId: string;
  state: NetworkState;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  models: string[];
}

const RANK: Record<NetworkState, number> = {
  [NETWORK_STATES.ONLINE]: 0,
  [NETWORK_STATES.OFFLINE]: 1,
  [NETWORK_STATES.UNPUBLISHED]: 2,
};

export function parseNetworkQuery(url: string) {
  if (new URL(url).search !== '') indexFail(INDEX_ERRORS.INVALID_QUERY);
}

// Online with a live presence for its live catalog; unpublished when never seen or withdrawn; else offline.
function nodeOf(
  nodeId: string,
  sighting: Sighting | undefined,
  catalog: CatalogStatusRow | undefined,
): NetworkNode {
  const state = catalog?.online
    ? NETWORK_STATES.ONLINE
    : !sighting || catalog?.withdrawn
      ? NETWORK_STATES.UNPUBLISHED
      : NETWORK_STATES.OFFLINE;
  return {
    nodeId,
    state,
    firstSeenAt: sighting?.firstAt ?? null,
    lastSeenAt: sighting?.lastAt ?? null,
    models: catalog?.online ? catalog.models : [],
  };
}

// Online first, then the most recently seen, then by NodeId.
function compareNodes(left: NetworkNode, right: NetworkNode) {
  if (left.state !== right.state) return RANK[left.state] - RANK[right.state];
  const seen = (right.lastSeenAt ?? -1) - (left.lastSeenAt ?? -1);
  if (seen !== 0) return seen;
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}

async function knownNodes(
  storage: DiscoveryStorage,
  registrations: RegistrationStore | undefined,
  now: number,
) {
  const [registered, sightings, catalogs] = await Promise.all([
    registrations?.registered(NETWORK.maxNodes) ?? [],
    storage.sightings(reportedHour(now), NETWORK.maxNodes),
    storage.catalogStatus(now, NETWORK.maxNodes, NETWORK.maxModelRows),
  ]);
  const revoked = new Set(
    registered.filter((row) => !row.active).map((row) => row.nodeId),
  );
  const seen = new Map(sightings.map((row) => [row.nodeId, row]));
  const stored = new Map(catalogs.map((row) => [row.nodeId, row]));
  const members = new Set([
    ...registered.filter((row) => row.active).map((row) => row.nodeId),
    ...sightings.filter((row) => row.lastAt !== null).map((row) => row.nodeId),
    ...catalogs.filter((row) => row.online).map((row) => row.nodeId),
  ]);
  return [...members]
    .filter((nodeId) => !revoked.has(nodeId))
    .map((nodeId) => nodeOf(nodeId, seen.get(nodeId), stored.get(nodeId)))
    .sort(compareNodes);
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

// Counts cover every known seller; the list stops before the response would exceed `maxBytes`.
export async function networkPage(
  storage: DiscoveryStorage,
  registrations: RegistrationStore | undefined,
  now: number,
  maxBytes: number,
) {
  const nodes = await knownNodes(storage, registrations, now);
  const counts = { total: nodes.length, online: 0, offline: 0, unpublished: 0 };
  for (const node of nodes) counts[node.state]++;
  const entries: string[] = [];
  let used = NETWORK.framingBytes;
  for (const node of nodes) {
    const entry = JSON.stringify(node);
    used += byteLength(entry) + 1;
    if (used > maxBytes) break;
    entries.push(entry);
  }
  const truncated = entries.length < nodes.length;
  return `{"counts":${JSON.stringify(counts)},"nodes":[${entries.join(',')}],"truncated":${truncated},"generatedAt":${now}}`;
}
