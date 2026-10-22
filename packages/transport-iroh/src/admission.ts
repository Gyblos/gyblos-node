// Owns admission in transport-iroh; it must not know wallets or inference engines.
import { isIP } from 'node:net';

import type { IncomingAddr } from '@number0/iroh';

import { P2P } from '@gyblos/config';

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

export function createConnectionAdmission() {
  const sources = new Map<string, number>();
  const peers = new Map<string, number>();
  let pending = 0;
  let established = 0;
  return {
    pending(source: string) {
      if (
        pending >= P2P.maxPendingConnections ||
        (sources.get(source) ?? 0) >= P2P.maxPendingPerSource
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
      if (
        established >= P2P.maxConnections ||
        (peers.get(peer) ?? 0) >= P2P.maxPeerConnections
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
