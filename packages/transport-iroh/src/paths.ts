// Classifies a connection's selected path as direct, relay or unknown, and decides what relay-only
// allows. It reads one path snapshot per decision and never opens, closes or rebinds connections.
import { isIP } from 'node:net';

import type { Connection } from '@number0/iroh';

import { IP_FAMILIES, LOOPBACK, TRANSPORT_ROUTES } from './constants';
import type { TransportRoute } from './types';

type PathSource = Pick<Connection, 'paths'>;
type PathSnapshot = ReturnType<Connection['paths']>[number];

// `[v6]:port` or `[v6]`, `v4:port` or `v4`, and an IPv4-mapped IPv6 address.
const BRACKETED_V6 = /^\[([^\]]+)\](?::\d+)?$/;
const V4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/;
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

function selectedPath(connection: PathSource): PathSnapshot | undefined {
  const paths = connection.paths().filter((path) => path.isSelected);
  return paths.length === 1 ? paths[0] : undefined;
}

function routeOf(path: PathSnapshot | undefined): TransportRoute {
  if (path?.isIp && !path.isRelay) return TRANSPORT_ROUTES.DIRECT;
  if (path?.isRelay && !path.isIp) return TRANSPORT_ROUTES.RELAY;
  return TRANSPORT_ROUTES.UNKNOWN;
}

export function selectedRoute(connection: PathSource): TransportRoute {
  return routeOf(selectedPath(connection));
}

// Relay-only hides each peer's IP. A relay-only endpoint binds only loopback, so the one direct
// path it can select leads to a process on the same machine and reveals no address; it is allowed
// so a buyer and a seller can run on one host. Any other direct path is refused. Caveat: a local
// UDP forwarder (a tunnel or proxy listening on loopback) would also look like loopback.
export function relayOnlyAllows(connection: PathSource): boolean {
  const path = selectedPath(connection);
  const route = routeOf(path);
  if (route === TRANSPORT_ROUTES.RELAY) return true;
  return (
    route === TRANSPORT_ROUTES.DIRECT && isLoopbackAddress(path?.remoteAddr)
  );
}

// A name such as localhost is not an address; unusual spellings of loopback are refused.
function isLoopbackAddress(remote: unknown): boolean {
  if (typeof remote !== 'string') return false;
  const host =
    BRACKETED_V6.exec(remote)?.[1] ?? V4_WITH_PORT.exec(remote)?.[1] ?? remote;
  const family = isIP(host);
  if (family === IP_FAMILIES.V4) return isLoopbackV4(host);
  if (family !== IP_FAMILIES.V6) return false;
  const lower = host.toLowerCase();
  if (lower === LOOPBACK.v6) return true;
  const mapped = MAPPED_V4.exec(lower)?.[1];
  return mapped !== undefined && isLoopbackV4(mapped);
}

function isLoopbackV4(host: string) {
  return (
    isIP(host) === IP_FAMILIES.V4 &&
    host.split('.')[0] === LOOPBACK.v4FirstOctet
  );
}
