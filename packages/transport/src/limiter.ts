import { P2P } from '@gyblos/config';

interface PeerWindow {
  started: number;
  requests: number;
  active: number;
}

export function createPeerLimiter(now: () => number = Date.now) {
  const windows = new Map<string, PeerWindow>();
  let active = 0;
  let globalStarted = now();
  let globalRequests = 0;
  return {
    enter(nodeId: string) {
      const time = now();
      if (time - globalStarted >= P2P.rateWindowMs) {
        globalStarted = time;
        globalRequests = 0;
      }
      for (const [peer, window] of windows) {
        if (time - window.started < P2P.rateWindowMs) continue;
        if (window.active === 0) windows.delete(peer);
        else {
          window.started = time;
          window.requests = 0;
        }
      }
      if (
        active >= P2P.maxConcurrent ||
        globalRequests >= P2P.globalRequestsPerWindow
      )
        return undefined;
      let window = windows.get(nodeId);
      if (!window) {
        if (windows.size >= P2P.maxPeers) {
          const oldest = [...windows].find(([, peer]) => peer.active === 0);
          if (!oldest) return undefined;
          windows.delete(oldest[0]);
        }
        window = { started: time, requests: 0, active: 0 };
      }
      if (
        window.active >= P2P.maxPeerConcurrent ||
        window.requests >= P2P.requestsPerWindow
      )
        return undefined;
      // Move accepted peers to the end; active ownership is never evicted.
      windows.delete(nodeId);
      windows.set(nodeId, window);
      window.requests++;
      window.active++;
      globalRequests++;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
          window.active--;
        }
      };
    },
  };
}
