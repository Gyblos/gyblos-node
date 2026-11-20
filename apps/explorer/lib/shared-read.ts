// Owns how one read of a public source is shared by the renders of a data center through the Workers
// Cache API (caches.default), so the load on the source does not grow with viewers:
// - a fresh entry serves every render without a read (freshness counts from the end of the read);
// - past its freshness, one render takes a lease that outlasts its slowest possible read and reads,
//   while the others keep serving the last entry (kept for `keepSeconds`);
// - without an entry (a cold cache), the others wait a little for that read instead of reading too;
// - a failed read turns the lease into a back-off, so nobody reads again before it ends, and the last
//   entry is served marked as old (`staleFrom`);
// - a partial read (some secondary answers missing) is fresh for a shorter time;
// - a lease is released only by its owner, and an older read never replaces a newer entry.
// The Cache API has no atomic claim: renders that look in the same instant, as an entry goes stale,
// can each take the lease and read. The cache only saves reads: when it fails, the render reads the
// source itself.

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
  // Longer than the slowest possible read.
  readingLeaseSeconds: number;
  failedBackoffSeconds: number;
  // How long a render without an entry waits for another render's read, and how often it looks.
  waitSeconds: number;
  waitPollMs: number;
}
export interface Loaded<T> {
  value: T;
  // False when a secondary answer was missing: fresh for partialFreshSeconds only.
  complete: boolean;
}
export interface Shared<T> {
  value: T;
  // When the source failed and an older read is served: when that read ended. Null otherwise.
  staleFrom: number | null;
}
interface Entry<T> {
  value: T;
  startedAt: number;
  readAt: number;
  freshUntil: number;
}
interface Lease {
  owner: string;
  state: 'reading' | 'failed';
}

const MS_PER_SECOND = 1000;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    // Not shared this time; a later render reads.
  }
}

async function waitForEntry<T>(
  store: SharedStore,
  policy: SharePolicy,
  clock: () => number,
  wait: (ms: number) => Promise<void>,
): Promise<Entry<T> | undefined> {
  const deadline = clock() + policy.waitSeconds * MS_PER_SECOND;
  while (clock() < deadline) {
    await wait(policy.waitPollMs);
    const entry = await get<Entry<T>>(store, policy.key);
    if (entry) return entry;
  }
  return undefined;
}

export async function sharedRead<T>(
  store: SharedStore | null,
  policy: SharePolicy,
  clock: () => number,
  load: () => Promise<Loaded<T>>,
  failed: (error: unknown) => T,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Shared<T>> {
  const fresh = (value: T): Shared<T> => ({ value, staleFrom: null });
  if (!store)
    return load().then(
      (loaded) => fresh(loaded.value),
      (error: unknown) => fresh(failed(error)),
    );
  const leaseKey = `${policy.key}/lease`;
  const startedAt = clock();
  const entry = await get<Entry<T>>(store, policy.key);
  if (entry && startedAt < entry.freshUntil) return fresh(entry.value);
  const lease = await get<Lease>(store, leaseKey);
  if (lease?.state === 'failed')
    return entry
      ? { value: entry.value, staleFrom: entry.readAt }
      : fresh(failed(new Error('source backing off')));
  if (lease) {
    if (entry) return fresh(entry.value);
    const waited = await waitForEntry<T>(store, policy, clock, wait);
    return fresh(
      waited ? waited.value : failed(new Error('source read in progress')),
    );
  }
  const owner = crypto.randomUUID();
  await set(
    store,
    leaseKey,
    { owner, state: 'reading' } satisfies Lease,
    policy.readingLeaseSeconds,
  );
  let loaded: Loaded<T>;
  try {
    loaded = await load();
  } catch (error) {
    await set(
      store,
      leaseKey,
      { owner, state: 'failed' } satisfies Lease,
      policy.failedBackoffSeconds,
    );
    return entry
      ? { value: entry.value, staleFrom: entry.readAt }
      : fresh(failed(error));
  }
  const readAt = clock();
  const latest = await get<Entry<T>>(store, policy.key);
  if (!latest || latest.startedAt <= startedAt) {
    const seconds = loaded.complete
      ? policy.freshSeconds
      : policy.partialFreshSeconds;
    await set(
      store,
      policy.key,
      {
        value: loaded.value,
        startedAt,
        readAt,
        freshUntil: readAt + seconds * MS_PER_SECOND,
      } satisfies Entry<T>,
      policy.keepSeconds,
    );
  }
  const held = await get<Lease>(store, leaseKey);
  if (held?.owner === owner) await store.delete(leaseKey).catch(() => false);
  return fresh(loaded.value);
}
