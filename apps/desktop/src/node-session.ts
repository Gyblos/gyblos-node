// Owns one local-node process until its actual exit; never reads wallets or node configuration.
import { LOCAL_NODE_STATE, type LocalNodeState } from './node-status';
import type { ProbeWorker } from './probe-session';

export function createDesktopNodeSession(
  _fork: () => ProbeWorker,
  _signal: AbortSignal,
) {
  return {
    summary: (): LocalNodeState => LOCAL_NODE_STATE.STOPPED,
    start() {},
    async close() {},
  };
}
