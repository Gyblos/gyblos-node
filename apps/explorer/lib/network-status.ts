// Owns the shape of the discovery index's network status (GET /v1/network): every registered or recently
// seen seller and whether it is online now, offline (seen before, no live presence) or unpublished
// (never seen, or its catalog withdrawn while the index keeps it). `truncated` means a source hit its cap:
// nodes, counts or models may be incomplete. Checked at the boundary; exact keys, nothing private. Pure, no I/O.
import {
  flag,
  list,
  nullable,
  num,
  record,
  SourceShapeError,
  text,
} from './validate';

export const NODE_STATES = ['online', 'offline', 'unpublished'] as const;
export type NodeState = (typeof NODE_STATES)[number];

export interface GithubAccount {
  account: string;
  gist: string;
}
export interface NetworkNode {
  nodeId: string;
  state: NodeState;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  models: string[];
  github: GithubAccount | null;
}
export interface NetworkStatus {
  counts: {
    total: number;
    online: number;
    offline: number;
    unpublished: number;
  };
  nodes: NetworkNode[];
  truncated: boolean;
  generatedAt: number;
}

function state(value: unknown): NodeState {
  const read = text(value, 'node.state');
  const known = NODE_STATES.find((candidate) => candidate === read);
  if (!known) throw new SourceShapeError('node.state');
  return known;
}
function github(value: unknown): GithubAccount | null {
  if (value === undefined || value === null) return null;
  const source = record(value, 'node.github');
  return {
    account: text(source.account, 'node.github.account'),
    gist: text(source.gist, 'node.github.gist'),
  };
}
const time = (value: unknown, where: string) =>
  nullable(value, (present) => num(present, where));

function node(value: unknown): NetworkNode {
  const source = record(value, 'node');
  return {
    nodeId: text(source.nodeId, 'node.nodeId'),
    state: state(source.state),
    firstSeenAt: time(source.firstSeenAt, 'node.firstSeenAt'),
    lastSeenAt: time(source.lastSeenAt, 'node.lastSeenAt'),
    models: list(source.models, 'node.models').map((model) =>
      text(model, 'node.model'),
    ),
    github: github(source.github),
  };
}

export function parseNetworkStatus(value: unknown): NetworkStatus {
  const source = record(value, 'network');
  const counts = record(source.counts, 'network.counts');
  const count = (key: string) => num(counts[key], `network.counts.${key}`);
  return {
    counts: {
      total: count('total'),
      online: count('online'),
      offline: count('offline'),
      unpublished: count('unpublished'),
    },
    nodes: list(source.nodes, 'network.nodes').map(node),
    truncated: flag(source.truncated, 'network.truncated'),
    generatedAt: num(source.generatedAt, 'network.generatedAt'),
  };
}

// The sellers not online now, most recently seen first (the index's own order is kept).
export const notOnline = (status: NetworkStatus) =>
  status.nodes.filter((entry) => entry.state !== 'online');
