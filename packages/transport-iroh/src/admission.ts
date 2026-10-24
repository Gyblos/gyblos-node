// Connection admission for the Iroh server: source keys per IP or relay endpoint and caps on pending,
// per-source and per-peer connections.
import { isIP } from 'node:net';

import type { IncomingAddr } from '@number0/iroh';

import { TRANSPORT_LIMITS } from '@gyblos/config';

import { createConnectionRate } from './connection-rate.js';

export function connectionSource(source: IncomingAddr): string | undefined {
  if (source.kind === 'relay' && source.endpointId)
    return `relay:${source.endpointId.toLowerCase()}`;
  if (source.kind !== 'ip' || !source.addr) return undefined;
  try {
    const address = new URL(`udp://${source.addr}`);
    const host = address.hostname.replace(/^\[|\]$/g, '');
    if (
      !isIP(host) ||
      !address.port ||
      address.username ||
      address.password ||
      address.pathname !== '' ||
      address.search ||
      address.hash
    )
      return undefined;
    return `ip:${host}`;
  } catch {
    return undefined;
  }
}

export function createConnectionAdmission(
  now: () => number = () => performance.now(),
) {
  const sources = new Map<string, number>();
  const peers = new Map<string, number>();
  const rate = createConnectionRate(now);
  let pending = 0;
  let established = 0;
  return {
    attempt: rate.attempt,
    pending(source: string) {
      if (
        pending >= TRANSPORT_LIMITS.maxPendingConnections ||
        (sources.get(source) ?? 0) >= TRANSPORT_LIMITS.maxPendingPerSource
      )
        return undefined;
      pending++;
      sources.set(source, (sources.get(source) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending--;
        const remaining = (sources.get(source) ?? 1) - 1;
        if (remaining === 0) sources.delete(source);
        else sources.set(source, remaining);
      };
    },
    established(peer: string) {
      if (!rate.peer(peer)) return undefined;
      if (
        established >= TRANSPORT_LIMITS.maxConnections ||
        (peers.get(peer) ?? 0) >= TRANSPORT_LIMITS.maxPeerConnections
      )
        return undefined;
      established++;
      peers.set(peer, (peers.get(peer) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        established--;
        const remaining = (peers.get(peer) ?? 1) - 1;
        if (remaining === 0) peers.delete(peer);
        else peers.set(peer, remaining);
      };
    },
  };
}
