// Connection admission for the Iroh server: source keys per IP or relay endpoint and caps on pending,
// per-source and per-peer connections.
import { isIP } from 'node:net';

import type { IncomingAddr } from '@number0/iroh';

import { TRANSPORT_LIMITS, type TransportLimits } from '@gyblos/config';
import { CONTROL_ALPN } from '@gyblos/protocol/constants';

import { createConnectionRate } from './connection-rate';
import { CONNECTION_FAMILIES, type ConnectionFamily } from './constants';

export function connectionFamily(alpn: string): ConnectionFamily {
  return alpn === CONTROL_ALPN
    ? CONNECTION_FAMILIES.CONTROL
    : CONNECTION_FAMILIES.DATA;
}

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
  limits: TransportLimits = TRANSPORT_LIMITS,
) {
  const sources = new Map<string, number>();
  const peers = new Map<string, number>();
  const rate = createConnectionRate(now, limits);
  let pending = 0;
  let established = 0;
  return {
    attempt: rate.attempt,
    pending(source: string) {
      if (
        pending >= limits.maxPendingConnections ||
        (sources.get(source) ?? 0) >= limits.maxPendingPerSource
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
    // The per-peer connection-rate budget and the global pool are shared across families; only the
    // per-peer connection cap is per family.
    established(peer: string, family: ConnectionFamily) {
      if (!rate.peer(peer)) return undefined;
      const key = `${family}:${peer}`;
      if (
        established >= limits.maxConnections ||
        (peers.get(key) ?? 0) >= limits.maxPeerConnections
      )
        return undefined;
      established++;
      peers.set(key, (peers.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        established--;
        const remaining = (peers.get(key) ?? 1) - 1;
        if (remaining === 0) peers.delete(key);
        else peers.set(key, remaining);
      };
    },
  };
}
