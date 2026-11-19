// Owns how one read of a public source is shared by the renders of a data center through the Workers
// Cache API (caches.default), so the load on the source does not grow with viewers:
// - a fresh entry serves every render without a read;
// - past its freshness, one render takes a short lease and reads, while the others keep serving the
//   last entry (kept for `keepSeconds`; the page shows its time);
// - a failed read leaves the lease in place as a back-off, so nobody reads again before it ends;
// - a partial read (some secondary answers missing) is shared for a shorter time.
// Without an entry, a render reads unless the last read failed within the back-off. Two renders can
// still both read when they start within the same instant (the Cache API has no atomic claim). The
// cache only saves reads: when it fails, the render reads the source itself.

export interface SharedStore {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export interface SharePolicy {
  // A URL of the explorer's own origin that no route serves.
  key: string;
  freshSeconds: number;
  partialFreshSeconds: number;
  keepSeconds: number;
  leaseSeconds: number;
}
export interface Loaded<T> {
  value: T;
  // False when a secondary answer was missing: shared for partialFreshSeconds only.
  complete: boolean;
}
interface Entry<T> {
  value: T;
  freshUntil: number;
}
type Lease = 'reading' | 'failed';

const MS_PER_SECOND = 1000;

// The data center's cache, or null where there is none (local runs and tests).
export function workersCache(): SharedStore | null {
  const store = (globalThis as { caches?: { default?: SharedStore } }).caches;
  return store?.default ?? null;
}

async function get<T>(store: SharedStore, key: string): Promise<T | undefined> {
  try {
    const response = await store.match(key);
    return response ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}
async function set(
  store: SharedStore,
  key: string,
  value: unknown,
  seconds: number,
) {
  try {
    await store.put(
      key,
      Response.json(value, {
        headers: { 'cache-control': `max-age=${seconds}` },
      }),
    );
  } catch {
    // Not shared this time; the next render reads.
  }
}

export async function sharedRead<T>(
  store: SharedStore | null,
  policy: SharePolicy,
  now: number,
  load: () => Promise<Loaded<T>>,
  failed: (error: unknown) => T,
): Promise<T> {
  if (!store)
    return load().then(
      (loaded) => loaded.value,
      (error: unknown) => failed(error),
    );
  const leaseKey = `${policy.key}/lease`;
  const entry = await get<Entry<T>>(store, policy.key);
  if (entry && now < entry.freshUntil) return entry.value;
  const lease = await get<Lease>(store, leaseKey);
  if (entry && lease) return entry.value;
  if (lease === 'failed') return failed(new Error('source backing off'));
  await set(store, leaseKey, 'reading', policy.leaseSeconds);
  let loaded: Loaded<T>;
  try {
    loaded = await load();
  } catch (error) {
    await set(store, leaseKey, 'failed', policy.leaseSeconds);
    return entry ? entry.value : failed(error);
  }
  const fresh = loaded.complete
    ? policy.freshSeconds
    : policy.partialFreshSeconds;
  await set(
    store,
    policy.key,
    { value: loaded.value, freshUntil: now + fresh * MS_PER_SECOND },
    policy.keepSeconds,
  );
  await store.delete(leaseKey).catch(() => false);
  return loaded.value;
}
