import { P2P } from '@gyblos/config';

export function createPeerLimiter(now: () => number = Date.now) {
  const windows = new Map<string, { started: number; requests: number }>();
  let active = 0;
  return {
    enter(nodeId: string) {
      const time = now();
      for (const [peer, window] of windows)
        if (time - window.started >= P2P.rateWindowMs) windows.delete(peer);
      if (active >= P2P.maxConcurrent) return undefined;
      let window = windows.get(nodeId);
      if (!window) {
        if (windows.size >= P2P.maxPeers) return undefined;
        window = { started: time, requests: 0 };
        windows.set(nodeId, window);
      }
      if (window.requests >= P2P.requestsPerWindow) return undefined;
      window.requests++;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
  };
}
