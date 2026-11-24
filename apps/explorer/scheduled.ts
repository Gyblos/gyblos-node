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
        console.error('discovery run failed: nothing stored');
      },
    ),
  );
}
