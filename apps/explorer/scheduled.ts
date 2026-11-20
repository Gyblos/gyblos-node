// Owns the explorer Worker's scheduled run (on the cron in wrangler.jsonc): it reads the discovery
// index into the DISCOVERY KV snapshot the page shows (lib/discovery-snapshot.ts). The Worker's entry, written by
// scripts/write-worker-entry.mjs after the OpenNext build, serves the page with OpenNext and runs this.
import { refreshDiscovery, type DiscoveryKv } from './lib/discovery-snapshot';

interface Bindings {
  DISCOVERY: DiscoveryKv;
}
interface Waiter {
  waitUntil(promise: Promise<unknown>): void;
}

export function scheduled(_event: unknown, bindings: Bindings, ctx: Waiter) {
  ctx.waitUntil(
    refreshDiscovery(bindings.DISCOVERY, Date.now).then(
      (problems) => {
        if (problems.length)
          console.error(`discovery run problems: ${problems.join(', ')}`);
      },
      () => {
        console.error('discovery run failed: KV unavailable');
      },
    ),
  );
}
