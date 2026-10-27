// Per-peer and global request quotas per window; consumed quota survives reconnects and eviction.
import { TRANSPORT_LIMITS, type TransportLimits } from '@gyblos/config';

import type { ConnectionFamily } from './constants';

interface PeerWindow {
  active: number;
  leases: number;
  reserved: number;
  // Leases by connection family; `leases` stays the total the quota logic uses.
  families: Map<ConnectionFamily, number>;
}

export function createPeerLimiter(
  now: () => number = Date.now,
  limits: TransportLimits = TRANSPORT_LIMITS,
) {
  const windows = new Map<string, PeerWindow>();
  // Only admitted work adds an entry, bounded by the global window budget.
  const requestCounts = new Map<string, number>();
  let active = 0;
  let globalStarted = now();
  let globalRequests = 0;

  function remaining() {
    return (
      limits.globalRequestsPerWindow -
      globalRequests -
      [...windows.values()].reduce((sum, window) => sum + window.reserved, 0)
    );
  }

  function refresh() {
    const time = now();
    if (time - globalStarted < limits.rateWindowMs) return;
    globalStarted = time;
    globalRequests = 0;
    requestCounts.clear();
    for (const [peer, window] of windows) {
      window.reserved = 0;
      if (window.active === 0 && window.leases === 0) windows.delete(peer);
    }
    for (const window of windows.values())
      if (window.leases > 0)
        window.reserved = Math.min(limits.requestsPerWindow, remaining());
  }

  function windowFor(nodeId: string) {
    let window = windows.get(nodeId);
    if (!window) {
      if (windows.size >= limits.maxPeers) {
        const inactive = ([, peer]: [string, PeerWindow]) =>
          peer.active === 0 && peer.leases === 0;
        const oldest =
          [...windows].find(
            (entry) => inactive(entry) && entry[1].reserved === 0,
          ) ?? [...windows].find(inactive);
        if (!oldest) return undefined;
        // Eviction returns only unused quota; consumed debt has separate storage.
        windows.delete(oldest[0]);
      }
      window = { active: 0, leases: 0, reserved: 0, families: new Map() };
    }
    windows.delete(nodeId);
    windows.set(nodeId, window);
    return window;
  }

  function reclaim(nodeId: string, needed: number) {
    for (const [peer, window] of windows) {
      const missing = needed - remaining();
      if (missing <= 0) break;
      if (peer === nodeId || window.active > 0 || window.leases > 0) continue;
      window.reserved -= Math.min(window.reserved, missing);
    }
  }

  return {
    register(nodeId: string, family: ConnectionFamily) {
      refresh();
      const requests = requestCounts.get(nodeId) ?? 0;
      if (
        requests >= limits.requestsPerWindow ||
        globalRequests >= limits.globalRequestsPerWindow ||
        (windows.get(nodeId)?.families.get(family) ?? 0) >=
          limits.maxPeerConnections
      )
        return undefined;
      const window = windowFor(nodeId);
      if (!window) return undefined;
      const needed = limits.requestsPerWindow - requests - window.reserved;
      reclaim(nodeId, needed);
      const additional = Math.min(needed, remaining());
      if (window.reserved + additional <= 0) return undefined;
      window.leases++;
      window.families.set(family, (window.families.get(family) ?? 0) + 1);
      window.reserved += additional;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        window.leases--;
        const held = (window.families.get(family) ?? 1) - 1;
        if (held === 0) window.families.delete(family);
        else window.families.set(family, held);
        // Disconnected, inactive grace can be reclaimed by another admission.
        if (
          window.leases === 0 &&
          window.active === 0 &&
          !requestCounts.has(nodeId)
        )
          window.reserved = 0;
      };
    },
    enter(nodeId: string) {
      refresh();
      const requests = requestCounts.get(nodeId) ?? 0;
      if (
        active >= limits.maxConcurrent ||
        requests >= limits.requestsPerWindow ||
        globalRequests >= limits.globalRequestsPerWindow
      )
        return undefined;
      const window = windowFor(nodeId);
      if (!window || window.active >= limits.maxPeerConcurrent)
        return undefined;
      if (window.reserved === 0) {
        if (window.leases > 0) return undefined;
        reclaim(nodeId, 1);
        if (remaining() <= 0) return undefined;
      }
      requestCounts.set(nodeId, requests + 1);
      window.active++;
      if (window.reserved > 0) window.reserved--;
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
