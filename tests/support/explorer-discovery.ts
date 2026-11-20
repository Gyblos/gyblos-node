// A fake discovery index and KV namespace for the explorer's discovery tests (tests/explorer-discovery*.test.ts):
// the index answers over a shape the test sets, recording every request and the uptime reads in flight.
import type { DiscoveryKv } from '@gyblos/explorer/discovery';

export interface IndexShape {
  // Sellers per model, by model id.
  models: Record<string, string[]>;
  // Node ids /network calls offline; null for no /network answer, 'malformed' for a bad one.
  offline?: string[] | null | 'malformed';
  down?: boolean;
  // Models whose /sellers pages fail; with `failLaterPages`, only their pages after the first.
  failSellers?: Set<string>;
  failLaterPages?: boolean;
  // Node ids whose seller entry is malformed.
  malformed?: Set<string>;
  failUptime?: Set<string>;
  perPage?: number;
  // Uptime answers wait this long, so reads overlap.
  uptimeDelayMs?: number;
}
const offer = (modelId: string) => ({
  modelId,
  variant: null,
  quantization: null,
  contextTokens: 8,
  pricing: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
});
function networkBody(shape: IndexShape, offline: string[]) {
  const gone = new Set(offline);
  const all = new Set([...Object.values(shape.models).flat(), ...offline]);
  const entries = [...all].map((nodeId) => ({
    nodeId,
    state: gone.has(nodeId) ? 'offline' : 'online',
    firstSeenAt: 1,
    lastSeenAt: 1,
    models: [],
  }));
  return {
    counts: {
      total: entries.length,
      online: entries.length - gone.size,
      offline: gone.size,
      unpublished: 0,
    },
    nodes: entries,
    truncated: false,
    generatedAt: 1,
  };
}
// A fake discovery index over `shape`; returns every requested path with its query, and the most
// uptime reads it had in flight at once.
export function fakeIndex(shape: IndexShape) {
  const requests: string[] = [];
  const uptimes = { inFlight: 0, most: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (shape.down) return new Response('{}', { status: 503 });
    const json = (body: unknown) => Response.json(body);
    if (url.pathname.endsWith('/models'))
      return json({
        generatedAt: 7,
        models: Object.keys(shape.models).map((id) => ({ id })),
      });
    if (url.pathname.endsWith('/sellers')) {
      const model = url.searchParams.get('model') ?? '';
      if (
        shape.failSellers?.has(model) &&
        (!shape.failLaterPages || url.searchParams.has('cursor'))
      )
        return new Response('{}', { status: 500 });
      const listed = shape.models[model] ?? [];
      const perPage = shape.perPage ?? Number(url.searchParams.get('limit'));
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = Math.min(start + perPage, listed.length);
      return json({
        sellers: listed.slice(start, end).map((nodeId) => ({
          catalog: {
            record: shape.malformed?.has(nodeId)
              ? { nodeId }
              : { nodeId, owner: 'o', models: [offer(model)] },
          },
        })),
        next: end < listed.length ? String(end) : null,
      });
    }
    if (url.pathname.endsWith('/uptime')) {
      uptimes.inFlight += 1;
      uptimes.most = Math.max(uptimes.most, uptimes.inFlight);
      await new Promise((resolve) =>
        setTimeout(resolve, shape.uptimeDelayMs ?? 0),
      );
      uptimes.inFlight -= 1;
      if (shape.failUptime?.has(url.searchParams.get('node') ?? ''))
        return new Response('{}', { status: 500 });
      return json({ firstSeenAt: 1, windows: [{ days: 1, ratio: 0.5 }] });
    }
    if (url.pathname.endsWith('/network') && shape.offline !== null)
      return json(
        shape.offline === 'malformed'
          ? { counts: 'no' }
          : networkBody(shape, shape.offline ?? []),
      );
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { requests, uptimes };
}
export const count = (requests: string[], path: string) =>
  requests.filter((request) => request.includes(path)).length;
export const nodes = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, index) => `${prefix}${index}`);
export const uptimeNodes = (requests: string[]) =>
  new Set(
    requests
      .filter((request) => request.includes('/uptime'))
      .map((request) => new URLSearchParams(request.split('?')[1]).get('node')),
  );

export function fakeKv() {
  const stored = new Map<string, string>();
  let gets = 0;
  const kv: DiscoveryKv = {
    get: async (key) => {
      gets += 1;
      return stored.get(key) ?? null;
    },
    put: async (key, value) => {
      stored.set(key, value);
    },
  };
  return { kv, stored, gets: () => gets };
}
export const MINUTE = 60 * 1000;
