// Owns the node's explicit start, stop and health lifecycle.
// Resource construction is injected; this module knows no SDKs or wallets.
import { NODE_STATES } from './constants.js';

export interface NodeHost {
  close(): Promise<void>;
}

export function createNodeLifecycle(startHost: () => Promise<NodeHost>) {
  let pending: Promise<NodeHost> | undefined;
  let host: NodeHost | undefined;
  return {
    async start() {
      if (host) return;
      pending ??= startHost();
      try {
        host = await pending;
      } finally {
        pending = undefined;
      }
    },
    async stop() {
      if (pending) await pending;
      const running = host;
      host = undefined;
      await running?.close();
    },
    health() {
      return {
        state: host
          ? NODE_STATES.RUNNING
          : pending
            ? NODE_STATES.STARTING
            : NODE_STATES.STOPPED,
      };
    },
  };
}
