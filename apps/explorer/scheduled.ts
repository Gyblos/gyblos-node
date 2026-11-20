// Owns the explorer Worker's scheduled run (every 2 minutes, wrangler.jsonc): it reads the discovery
// index into the DISCOVERY KV snapshot the page shows (lib/discovery.ts). The Worker's entry, written by
// scripts/write-worker-entry.mjs after the OpenNext build, serves the page with OpenNext and runs this.
import { refreshDiscovery, type DiscoveryKv } from './lib/discovery';

interface Bindings {
  DISCOVERY: DiscoveryKv;
}
interface Waiter {
  waitUntil(promise: Promise<unknown>): void;
}

export function scheduled(_event: unknown, bindings: Bindings, ctx: Waiter) {
  ctx.waitUntil(
    refreshDiscovery(bindings.DISCOVERY, Date.now).catch((error: unknown) => {
      console.error(
        'discovery refresh failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }),
  );
}
