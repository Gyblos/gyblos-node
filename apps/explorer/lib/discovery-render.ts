// Owns a render's read of the discovery snapshot: from the Worker's KV binding (DISCOVERY), read once per
// render (the Network and Models sections share it). Under `next dev`, which has no binding, the render
// reads the index itself; a deployed Worker without the binding shows the index as unavailable.
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cache } from 'react';

import {
  loadSnapshot,
  readIndex,
  snapshotOf,
  type DiscoveryKv,
  type DiscoverySnapshot,
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

export const getDiscovery = cache(async (): Promise<DiscoverySnapshot> => {
  const kv = binding();
  if (kv) return loadSnapshot(kv, Date.now());
  const unavailable = (error: string) => ({
    ...snapshotOf(null, Date.now()),
    error,
  });
  if (process.env.NODE_ENV !== 'development')
    return unavailable('no DISCOVERY binding');
  try {
    return snapshotOf(await readIndex(null, Date.now), Date.now());
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : 'discovery unavailable',
    );
  }
});
