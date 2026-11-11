// Per-peer and global request quotas per window; consumed quota survives reconnects and eviction.
// Only execution counts as a request; surrounding queries, receipts and session administration share
// concurrency limits but not inference quota, and retain their own bounded query admission.
import { TRANSPORT_LIMITS, type TransportLimits } from '@gyblos/config';

import type { ConnectionFamily } from './constants';

interface PeerWindow {
  active: number;
  leases: number;
  quotaLeases: number; // Execution-only connections protect an allocated quota grant.
  reserved: number;
  // All connections, including mixed-session connections, share the same per-family cap.
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
      if (window.quotaLeases > 0)
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
      window = {
        active: 0,
        leases: 0,
        quotaLeases: 0,
        reserved: 0,
        families: new Map(),
      };
    }
    windows.delete(nodeId);
    windows.set(nodeId, window);
    return window;
  }

  function reclaim(nodeId: string, needed: number) {
    for (const [peer, window] of windows) {
      const missing = needed - remaining();
      if (missing <= 0) break;
      if (peer === nodeId || window.active > 0 || window.quotaLeases > 0)
        continue;
      window.reserved -= Math.min(window.reserved, missing);
    }
  }

  function register(
    nodeId: string,
    family: ConnectionFamily,
    reserveQuota: boolean,
  ) {
    refresh();
    const requests = requestCounts.get(nodeId) ?? 0;
    if (
      (reserveQuota && requests >= limits.requestsPerWindow) ||
      (reserveQuota && globalRequests >= limits.globalRequestsPerWindow) ||
      (windows.get(nodeId)?.families.get(family) ?? 0) >=
        limits.maxPeerConnections
    )
      return undefined;
    const window = windowFor(nodeId);
    if (!window) return undefined;
    if (reserveQuota) {
      const needed = limits.requestsPerWindow - requests - window.reserved;
      reclaim(nodeId, needed);
      const additional = Math.min(needed, remaining());
      if (window.reserved + additional <= 0) return undefined;
      window.reserved += additional;
      window.quotaLeases++;
    }
    window.leases++;
    window.families.set(family, (window.families.get(family) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      window.leases--;
      if (reserveQuota) window.quotaLeases--;
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
  }

  function consume(nodeId: string, window: PeerWindow) {
    const requests = requestCounts.get(nodeId) ?? 0;
    if (
      requests >= limits.requestsPerWindow ||
      globalRequests >= limits.globalRequestsPerWindow
    )
      return false;
    if (window.reserved === 0) {
      if (window.quotaLeases > 0) return false;
      reclaim(nodeId, 1);
      if (remaining() <= 0) return false;
    }
    requestCounts.set(nodeId, requests + 1);
    if (window.reserved > 0) window.reserved--;
    globalRequests++;
    return true;
  }

  return {
    register: (nodeId: string, family: ConnectionFamily) =>
      register(nodeId, family, true),
    // A mixed session connection must remain reachable for recovery after execution quota is spent.
    registerQuery: (nodeId: string, family: ConnectionFamily) =>
      register(nodeId, family, false),
    // Charge a validated execution while its caller already owns the shared concurrency slot.
    consume(nodeId: string) {
      refresh();
      const window = windows.get(nodeId);
      return !!window && window.active > 0 && consume(nodeId, window);
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
      if (!consume(nodeId, window)) return undefined;
      window.active++;
      active++;
      return activeLease(window);
    },
    // A control query or receipt: one at a time per buyer within the same concurrency, outside the quota.
    enterQuery(nodeId: string) {
      refresh();
      if (active >= limits.maxConcurrent) return undefined;
      const window = windowFor(nodeId);
      if (!window || window.active >= limits.maxPeerConcurrent)
        return undefined;
      window.active++;
      active++;
      return activeLease(window);
    },
  };

  function activeLease(window: PeerWindow) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      window.active--;
    };
  }
}
