import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS, LOOPBACK_HOST_NAMES } from '@gyblos/config';

/**
 * True only for a loopback literal with the exact expected port, e.g.
 * `127.0.0.1:4022`, `localhost:4022` or `[::1]:4022` (host name case-insensitive).
 */
export function isLoopbackHost(host: string | undefined, port: number) {
  if (!host || !Number.isSafeInteger(port) || port <= 0) return false;
  const value = host.toLowerCase();
  return LOOPBACK_HOST_NAMES.some((name) => value === `${name}:${port}`);
}

/**
 * Answers a DNS-rebinding request with 421 and returns false; the expected port
 * is the connection's local port, so ephemeral listeners need no configuration.
 */
export function acceptLoopbackHost(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (isLoopbackHost(request.headers.host, request.socket.localPort ?? 0))
    return true;
  response
    .writeHead(HTTP_STATUS.misdirectedRequest, { connection: 'close' })
    .end();
  return false;
}

/** Express/connect middleware: runs before any route handler or body parser. */
export function requireLoopbackHost(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  if (acceptLoopbackHost(request, response)) next();
}
