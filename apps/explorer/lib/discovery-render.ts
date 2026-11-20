// Owns a render's read of the discovery snapshot: from the Worker's KV binding (DISCOVERY), read once per
// render (the Network and Models sections share it). Under `next dev`, which has no binding, a render
// runs the scheduled read itself, at most once per DISCOVERY.reuseMs; a deployed Worker without the
// binding shows the index as unavailable.
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cache } from 'react';

import { DISCOVERY } from './constants';
import {
  loadSnapshot,
  readIndex,
  snapshotOf,
  unavailable,
  type DiscoveryKv,
  type DiscoverySnapshot,
  type RunProblem,
  type StoredDiscovery,
} from './discovery';

declare global {
  interface CloudflareEnv {
    DISCOVERY?: DiscoveryKv;
  }
}

function binding(): DiscoveryKv | null {
  try {
    return getCloudflareContext().env.DISCOVERY ?? null;
  } catch {
    return null;
  }
}

// The development server's last run (a Node process, where a value is shared by every request).
let development: {
  at: number;
  stored: StoredDiscovery;
  problems: RunProblem[];
} | null = null;

export const getDiscovery = cache(async (): Promise<DiscoverySnapshot> => {
  const kv = binding();
  if (kv) return loadSnapshot(kv, Date.now());
  if (process.env.NODE_ENV !== 'development')
    return unavailable('no DISCOVERY binding');
  if (!development || Date.now() - development.at >= DISCOVERY.reuseMs) {
    const { stored, problems } = await readIndex(
      development?.stored ?? null,
      Date.now,
    );
    development = { at: Date.now(), stored, problems };
  }
  return development.stored.catalog || !development.problems.length
    ? snapshotOf(development.stored, Date.now())
    : unavailable(`discovery: ${development.problems.join(', ')}`);
});
