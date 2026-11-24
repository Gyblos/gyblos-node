// Owns GET /v1/network: every seller the index knows and whether it is online now, so anyone can count
// the network's online, offline and unpublished sellers. Registered NodeIds are already public on chain
// (the 8004 registry binds each one to its owner), so they are listed even before they publish. A seller
// published without a registration (allowlist or open mode) is listed while seen within the last 30
// days. A revoked NodeId is listed only while it is online, exactly as /v1/sellers lists it. Takes no
// parameters; cached like a sellers page. Built only from records the index verified and from its own
// registrations; no IP, contact, owner or country is returned. Each node also carries `github`: its
// verified GitHub account and proof gist, or null; unproven claims are read only through GET
// /v1/identity/github. A failed claims read leaves every `github` null and the page `truncated`.
import {
  INDEX_ERRORS,
  NETWORK,
  NETWORK_STATES,
  type NetworkState,
} from './constants';
import { indexFail } from './errors';
import type { GithubClaimStore } from './github-claim-store';
import type { SellerProfileStore } from './profile-store';
import type { RegistrationStore } from './registration-store';
import type { CatalogStatusRow, DiscoveryStorage } from './storage';
import { reportedHour, type Sighting } from './uptime';

interface NetworkNode {
  nodeId: string;
  state: NetworkState;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  models: string[];
  github: { account: string; gist: string } | null;
  name: string | null;
}

export interface NetworkIdentity {
  claims?: GithubClaimStore;
  profiles?: SellerProfileStore;
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
  github: { account: string; gist: string } | undefined,
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
    github: github ? { account: github.account, gist: github.gist } : null,
    name: null,
  };
}

// Online first, then the most recently seen, then by NodeId.
function compareNodes(left: NetworkNode, right: NetworkNode) {
  if (left.state !== right.state) return RANK[left.state] - RANK[right.state];
  const seen = (right.lastSeenAt ?? -1) - (left.lastSeenAt ?? -1);
  if (seen !== 0) return seen;
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}

// Verified claims, or none when the claims store is missing or its read fails (for example before
// migration 0007 is applied): GitHub data is optional to this route, but a failed read marks the page
// incomplete (`truncated`).
async function verifiedClaims(claims: GithubClaimStore | undefined) {
  if (!claims) return { rows: [], read: true };
  try {
    return { rows: await claims.verified(NETWORK.maxNodes), read: true };
  } catch {
    return { rows: [], read: false };
  }
}

async function withNames(
  nodes: NetworkNode[],
  eligible: ReadonlySet<string>,
  profiles: SellerProfileStore | undefined,
) {
  let rows: { nodeId: string; name: string }[] = [];
  let read = true;
  if (profiles)
    try {
      rows = await profiles.names(
        nodes
          .map((node) => node.nodeId)
          .filter((nodeId) => eligible.has(nodeId)),
      );
    } catch {
      read = false;
    }
  const named = new Map(rows.map((row) => [row.nodeId, row.name]));
  return {
    nodes: nodes.map((node) => ({
      ...node,
      name: named.get(node.nodeId) ?? null,
    })),
    read,
  };
}

async function knownNodes(
  storage: DiscoveryStorage,
  registrations: RegistrationStore | undefined,
  { claims, profiles }: NetworkIdentity,
  now: number,
) {
  const [registered, sightings, catalogs, github] = await Promise.all([
    registrations?.registered(NETWORK.maxNodes) ?? { active: [], revoked: [] },
    storage.sightings(reportedHour(now), NETWORK.maxNodes),
    storage.catalogStatus(now, NETWORK.maxNodes, NETWORK.maxModelRows),
    verifiedClaims(claims),
  ]);
  const claimed = new Map(github.rows.map((row) => [row.nodeId, row]));
  const revoked = new Set(registered.revoked);
  const seen = new Map(sightings.map((row) => [row.nodeId, row]));
  const stored = new Map(catalogs.rows.map((row) => [row.nodeId, row]));
  const members = new Set([
    ...registered.active,
    ...sightings.filter((row) => row.lastAt !== null).map((row) => row.nodeId),
    ...catalogs.rows.filter((row) => row.online).map((row) => row.nodeId),
  ]);
  const listed = [...members]
    .map((nodeId) =>
      nodeOf(nodeId, seen.get(nodeId), stored.get(nodeId), claimed.get(nodeId)),
    )
    .filter(
      (node) =>
        !revoked.has(node.nodeId) || node.state === NETWORK_STATES.ONLINE,
    )
    .sort(compareNodes);
  const eligible = new Set([
    ...registered.active,
    ...catalogs.rows.map((row) => row.nodeId),
  ]);
  const names = await withNames(listed, eligible, profiles);
  // A source that filled its cap may have left sellers (or online models or claims) out of the answer.
  const complete =
    catalogs.complete &&
    github.read &&
    github.rows.length < NETWORK.maxNodes &&
    names.read &&
    sightings.length < NETWORK.maxNodes &&
    registered.active.length < NETWORK.maxNodes &&
    registered.revoked.length < NETWORK.maxNodes;
  return { nodes: names.nodes, complete };
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

// Counts cover every listed seller; the list stops before the response would exceed `maxBytes`.
// `truncated` is true when the list stopped there or a source cap may have left sellers or models out.
export async function networkPage(
  storage: DiscoveryStorage,
  registrations: RegistrationStore | undefined,
  identity: NetworkIdentity = {},
  now: number,
  maxBytes: number,
) {
  const { nodes, complete } = await knownNodes(
    storage,
    registrations,
    identity,
    now,
  );
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
  const truncated = !complete || entries.length < nodes.length;
  return `{"counts":${JSON.stringify(counts)},"nodes":[${entries.join(',')}],"truncated":${truncated},"generatedAt":${now}}`;
}
