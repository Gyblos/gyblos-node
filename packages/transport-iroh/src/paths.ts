// Classifies a connection's selected path as direct, relay or unknown, and decides what relay-only allows.
import { isIP } from 'node:net';

import type { Connection } from '@number0/iroh';

import { LOOPBACK_ADDRESSES, TRANSPORT_ROUTES } from './constants';
import type { TransportRoute } from './types';

type PathSource = Pick<Connection, 'paths'>;

function selectedPath(connection: PathSource) {
  const paths = connection.paths().filter((path) => path.isSelected);
  return paths.length === 1 ? paths[0]! : undefined;
}

export function selectedRoute(connection: PathSource): TransportRoute {
  const path = selectedPath(connection);
  if (!path) return TRANSPORT_ROUTES.UNKNOWN;
  if (path.isIp && !path.isRelay) return TRANSPORT_ROUTES.DIRECT;
  if (path.isRelay && !path.isIp) return TRANSPORT_ROUTES.RELAY;
  return TRANSPORT_ROUTES.UNKNOWN;
}

// Relay-only hides each peer's IP. A relay-only endpoint binds only loopback, so the one direct
// path it can select leads to another process on the same machine and reveals no address; it is
// allowed so a buyer and a seller can run on one host. Any other direct path is refused.
export function relayOnlyAllows(connection: PathSource): boolean {
  const route = selectedRoute(connection);
  if (route === TRANSPORT_ROUTES.RELAY) return true;
  if (route !== TRANSPORT_ROUTES.DIRECT) return false;
  return isLoopbackAddress(selectedPath(connection)!.remoteAddr);
}

// Accepts `host:port`, `[v6]:port` or a bare IP; a name such as localhost is not an address.
function isLoopbackAddress(remote: unknown): boolean {
  if (typeof remote !== 'string') return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(remote);
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(remote);
  const host = bracketed?.[1] ?? v4?.[1] ?? remote;
  const family = isIP(host);
  if (family === LOOPBACK_ADDRESSES.v4Family) return isLoopbackV4(host);
  if (family !== LOOPBACK_ADDRESSES.v6Family) return false;
  const lower = host.toLowerCase();
  if (lower === LOOPBACK_ADDRESSES.v6) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)?.[1];
  return mapped !== undefined && isLoopbackV4(mapped);
}

function isLoopbackV4(host: string) {
  return (
    isIP(host) === LOOPBACK_ADDRESSES.v4Family &&
    host.split('.')[0] === LOOPBACK_ADDRESSES.v4FirstOctet
  );
}
