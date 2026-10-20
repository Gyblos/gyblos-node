import { P2P } from '@gyblos/config';

interface PeerWindow {
  requests: number;
  active: number;
  leases: number;
  reserved: number;
}

export function createPeerLimiter(now: () => number = Date.now) {
  const windows = new Map<string, PeerWindow>();
  let active = 0;
  let globalStarted = now();
  let globalRequests = 0;

  function remaining() {
    return (
      P2P.globalRequestsPerWindow -
      globalRequests -
      [...windows.values()].reduce((sum, window) => sum + window.reserved, 0)
    );
  }

  function refresh() {
    const time = now();
    if (time - globalStarted < P2P.rateWindowMs) return;
    globalStarted = time;
    globalRequests = 0;
    for (const [peer, window] of windows) {
      window.requests = 0;
      window.reserved = 0;
      if (window.active === 0 && window.leases === 0) windows.delete(peer);
    }
    for (const window of windows.values())
      if (window.leases > 0)
        window.reserved = Math.min(P2P.requestsPerWindow, remaining());
  }

  function windowFor(nodeId: string) {
    let window = windows.get(nodeId);
    if (!window) {
      if (windows.size >= P2P.maxPeers) {
        const oldest = [...windows].find(
          ([, peer]) => peer.active === 0 && peer.leases === 0,
        );
        if (!oldest) return undefined;
        windows.delete(oldest[0]);
      }
      window = { requests: 0, active: 0, leases: 0, reserved: 0 };
    }
    windows.delete(nodeId);
    windows.set(nodeId, window);
    return window;
  }

  return {
    register(nodeId: string) {
      refresh();
      const window = windowFor(nodeId);
      if (!window || window.leases >= P2P.maxPeerConnections) return undefined;
      const additional = Math.min(
        P2P.requestsPerWindow - window.requests - window.reserved,
        remaining(),
      );
      if (window.reserved + additional <= 0) return undefined;
      window.leases++;
      window.reserved += additional;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        window.leases--;
        // Releasing unused capacity never erases this window's consumed debt.
        if (window.leases === 0) window.reserved = 0;
      };
    },
    enter(nodeId: string) {
      refresh();
      if (active >= P2P.maxConcurrent) return undefined;
      const window = windowFor(nodeId);
      if (
        !window ||
        window.active >= P2P.maxPeerConcurrent ||
        window.requests >= P2P.requestsPerWindow ||
        (window.leases > 0 ? window.reserved <= 0 : remaining() <= 0)
      )
        return undefined;
      window.requests++;
      window.active++;
      if (window.leases > 0) window.reserved--;
      globalRequests++;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        window.active--;
      };
    },
  };
}
