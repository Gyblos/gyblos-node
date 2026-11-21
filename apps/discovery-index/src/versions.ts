// Count each active node once. A release is a signed seller declaration, independent of buyer compatibility.
import { NETWORK } from './constants';
import type { DiscoveryStorage } from './storage';

export async function versionsPage(
  storage: DiscoveryStorage,
  now: number,
  maxBytes: number,
  nodeId?: string,
) {
  const rows = await storage.activeVersions(
    now,
    nodeId ? 1 : NETWORK.maxNodes + 1,
    nodeId,
  );
  if (nodeId) return rows[0] ? JSON.stringify(rows[0]) : null;
  const active = Math.min(rows.length, NETWORK.maxNodes);
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const { version } of rows.slice(0, active)) {
    if (version === null) unknown++;
    else counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  const versions = [];
  let bytes = NETWORK.framingBytes;
  let truncated = rows.length > active;
  for (const version of [...counts.keys()].sort()) {
    const group = { version, nodes: counts.get(version)! };
    bytes += JSON.stringify(group).length + 1;
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    versions.push(group);
  }
  return JSON.stringify({ active, unknown, versions, truncated });
}
