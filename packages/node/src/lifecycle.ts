// Owns the node's explicit start, stop and health lifecycle.
// Resource construction is injected; this module knows no SDKs or wallets.
import { NODE_STATES, type NodeState } from './constants.js';
import type { createSellerPublisher } from './publisher.js';

export interface NodeHost {
  close(): Promise<void>;
  publication?: ReturnType<typeof createSellerPublisher>['health'];
}

export function createNodeLifecycle(startHost: () => Promise<NodeHost>) {
  let host: NodeHost | undefined;
  let state: NodeState = NODE_STATES.STOPPED;
  let transition = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const next = transition.then(operation);
    transition = next.catch(() => {});
    return next;
  };
  return {
    start() {
      return enqueue(async () => {
        if (host) return;
        state = NODE_STATES.STARTING;
        try {
          host = await startHost();
          state = NODE_STATES.RUNNING;
        } catch (error) {
          state = NODE_STATES.STOPPED;
          throw error;
        }
      });
    },
    stop() {
      return enqueue(async () => {
        const running = host;
        host = undefined;
        state = NODE_STATES.STOPPED;
        await running?.close();
      });
    },
    health() {
      return {
        state,
        ...(host?.publication ? { publication: host.publication() } : {}),
      };
    },
  };
}
